import { CommandType, RoutePlanner } from './shared/planner'
import { expect } from './shared/expect'
import { BigNumber } from 'ethers'
import { UniversalRouter, Permit2, ERC721, ERC20, ERC1155 } from '../../typechain'
import {
  seaportOrders,
  seaportInterface,
  getAdvancedOrderParams,
  purchaseDataForTwoCovensSeaport,
  calculateValue,
  ItemType,
} from './shared/protocolHelpers/seaport'
import deployUniversalRouter, { deployPermit2 } from './shared/deployUniversalRouter'
import { CAMEO_1155, COVEN_721, resetFork, WETH } from './shared/mainnetForkHelpers'
import { abi as ERC20_ABI } from '../../artifacts/solmate/src/tokens/ERC20.sol/ERC20.json'
import {
  ALICE_ADDRESS,
  DEADLINE,
  ETH_ADDRESS,
  MSG_SENDER,
  OPENSEA_CONDUIT,
  OPENSEA_CONDUIT_KEY,
} from './shared/constants'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import hre from 'hardhat'
import { getTxGasSpent } from './shared/helpers'
import { ADDRESS_ZERO } from '@uniswap/v3-sdk'
const { ethers } = hre

describe('Seaport', () => {
  let alice: SignerWithAddress
  let router: UniversalRouter
  let permit2: Permit2
  let planner: RoutePlanner
  let cryptoCovens: ERC721
  let cameoPass: ERC1155

  beforeEach(async () => {
    await resetFork()
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [ALICE_ADDRESS],
    })
    alice = await ethers.getSigner(ALICE_ADDRESS)
    permit2 = (await deployPermit2()).connect(alice) as Permit2
    router = (await deployUniversalRouter(permit2)).connect(alice) as UniversalRouter
    planner = new RoutePlanner()
    cryptoCovens = COVEN_721.connect(alice) as ERC721
    cameoPass = CAMEO_1155.connect(alice) as ERC1155
  })

  it('completes a fulfillAdvancedOrder type', async () => {
    const { advancedOrder, value } = getAdvancedOrderParams(seaportOrders[0])
    const params = advancedOrder.parameters
    const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
      advancedOrder,
      [],
      OPENSEA_CONDUIT_KEY,
      alice.address,
    ])

    planner.addCommand(CommandType.SEAPORT, [value.toString(), calldata])
    const { commands, inputs } = planner

    const ownerBefore = await cryptoCovens.ownerOf(params.offer[0].identifierOrCriteria)
    const ethBefore = await ethers.provider.getBalance(alice.address)
    const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value })).wait()
    const ownerAfter = await cryptoCovens.ownerOf(params.offer[0].identifierOrCriteria)
    const ethAfter = await ethers.provider.getBalance(alice.address)
    const gasSpent = getTxGasSpent(receipt)
    const ethDelta = ethBefore.sub(ethAfter)

    expect(ownerBefore.toLowerCase()).to.eq(params.offerer)
    expect(ownerAfter).to.eq(alice.address)
    expect(ethDelta.sub(gasSpent)).to.eq(value)
  })

  it('revertable fulfillAdvancedOrder reverts and sweeps ETH', async () => {
    let { advancedOrder, value } = getAdvancedOrderParams(seaportOrders[0])
    const params = advancedOrder.parameters
    const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
      advancedOrder,
      [],
      OPENSEA_CONDUIT_KEY,
      alice.address,
    ])

    // Allow seaport to revert
    planner.addCommand(CommandType.SEAPORT, [value.toString(), calldata], true)
    planner.addCommand(CommandType.SWEEP, [ETH_ADDRESS, alice.address, 0])

    const commands = planner.commands
    const inputs = planner.inputs

    const ownerBefore = await cryptoCovens.ownerOf(params.offer[0].identifierOrCriteria)
    const ethBefore = await ethers.provider.getBalance(alice.address)

    // don't send enough ETH, so the seaport purchase reverts
    value = BigNumber.from(value).sub('1')
    const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value })).wait()

    const ownerAfter = await cryptoCovens.ownerOf(params.offer[0].identifierOrCriteria)
    const ethAfter = await ethers.provider.getBalance(alice.address)
    const gasSpent = getTxGasSpent(receipt)
    const ethDelta = ethBefore.sub(ethAfter)

    // The owner was unchanged, the user got the eth back
    expect(ownerBefore.toLowerCase()).to.eq(ownerAfter.toLowerCase())
    expect(ethDelta).to.eq(gasSpent)
  })

  it('completes a fulfillAvailableAdvancedOrders type', async () => {
    const { calldata, advancedOrder0, advancedOrder1, value } = purchaseDataForTwoCovensSeaport(alice.address)
    const params0 = advancedOrder0.parameters
    const params1 = advancedOrder1.parameters
    planner.addCommand(CommandType.SEAPORT, [value.toString(), calldata])
    const { commands, inputs } = planner

    const owner0Before = await cryptoCovens.ownerOf(params0.offer[0].identifierOrCriteria)
    const owner1Before = await cryptoCovens.ownerOf(params1.offer[0].identifierOrCriteria)
    const ethBefore = await ethers.provider.getBalance(alice.address)

    const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value })).wait()

    const owner0After = await cryptoCovens.ownerOf(params0.offer[0].identifierOrCriteria)
    const owner1After = await cryptoCovens.ownerOf(params1.offer[0].identifierOrCriteria)
    const ethAfter = await ethers.provider.getBalance(alice.address)
    const gasSpent = getTxGasSpent(receipt)
    const ethDelta = ethBefore.sub(ethAfter)

    expect(owner0Before.toLowerCase()).to.eq(params0.offerer)
    expect(owner1Before.toLowerCase()).to.eq(params1.offerer)
    expect(owner0After).to.eq(alice.address)
    expect(owner1After).to.eq(alice.address)
    expect(ethDelta.sub(gasSpent)).to.eq(value)
  })

  it('reverts if order does not go through', async () => {
    let invalidSeaportOrder = JSON.parse(JSON.stringify(seaportOrders[0]))
    invalidSeaportOrder.protocol_data.signature = '0xdeadbeef'
    const { advancedOrder: seaportOrder, value: seaportValue } = getAdvancedOrderParams(invalidSeaportOrder)

    const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
      seaportOrder,
      [],
      OPENSEA_CONDUIT_KEY,
      alice.address,
    ])

    planner.addCommand(CommandType.SEAPORT, [seaportValue.toString(), calldata])
    const { commands, inputs } = planner

    await expect(
      router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value: seaportValue })
    ).to.be.revertedWith('ExecutionFailed(0, "0x8baa579f")')
  })

  describe('Seaport SELL ERC721 -> ERC20 (WETH)', async () => {
    let weth: ERC20
    const id = 5757

    beforeEach(async () => {
      await resetFork(16199548) // found using cast find-block w/ listing timestamp of order
      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [ALICE_ADDRESS],
      })
      alice = await ethers.getSigner(ALICE_ADDRESS)
      permit2 = (await deployPermit2()).connect(alice) as Permit2
      router = (await deployUniversalRouter(permit2)).connect(alice) as UniversalRouter
      planner = new RoutePlanner()
      const routerSigner = await ethers.getImpersonatedSigner(router.address)
      weth = new ethers.Contract(WETH.address, ERC20_ABI).connect(routerSigner) as ERC20

      // send 1 eth from alice to router.address for weth approval
      await (await alice.sendTransaction({ to: router.address, value: ethers.utils.parseEther('1.0') })).wait()
      // max approve conduit for weth
      await weth.approve(OPENSEA_CONDUIT, ethers.constants.MaxUint256)

      const prevCovensOwner = await cryptoCovens.ownerOf(id)
      await cryptoCovens
        .connect(await ethers.getImpersonatedSigner(prevCovensOwner))
        .transferFrom(prevCovensOwner, alice.address, id)
    })

    it('completes an advanced order offering WETH', async () => {
      let { advancedOrder, value } = getAdvancedOrderParams(seaportOrders[2], [ItemType.ERC20])
      const params = advancedOrder.parameters
      const wethReceived = BigNumber.from(params.offer[0].startAmount).sub(value)
      // Can add logic to select approval target (conduit or consideration) depending on conduitHash
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        advancedOrder,
        [],
        OPENSEA_CONDUIT_KEY,
        ADDRESS_ZERO, // 0 addr so router custody
      ])
      planner.addCommand(CommandType.SEAPORT_SELL_721, [
        calldata,
        cryptoCovens.address,
        OPENSEA_CONDUIT,
        id,
        alice.address,
      ])
      planner.addCommand(CommandType.SWEEP, [WETH.address, MSG_SENDER, 0])
      const { commands, inputs } = planner

      const wethBefore = await weth.balanceOf(alice.address)
      const ownerBefore = await cryptoCovens.ownerOf(id)

      // put NFT in the router TODO replace with Permit2 721
      await cryptoCovens.transferFrom(alice.address, router.address, id)

      const ethBefore = await ethers.provider.getBalance(alice.address)
      const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, {})).wait()

      const ownerAfter = await cryptoCovens.ownerOf(id)
      const wethAfter = await weth.balanceOf(alice.address)
      const ethAfter = await ethers.provider.getBalance(alice.address)
      const gasSpent = getTxGasSpent(receipt)
      const ethDelta = ethBefore.sub(ethAfter)

      expect(ownerBefore).to.eq(alice.address)
      expect(ownerAfter.toLowerCase()).to.eq(params.offerer.toLowerCase())
      expect(wethAfter.sub(wethBefore)).to.eq(wethReceived)
      expect(ethDelta).to.eq(gasSpent)
    })

    it('revertable order returns NFT to user if reverts', async () => {
      let { advancedOrder: invalidOrder } = getAdvancedOrderParams(seaportOrders[2])
      invalidOrder.signature = '0xdeadbeef'
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        invalidOrder,
        [],
        OPENSEA_CONDUIT_KEY,
        ADDRESS_ZERO, // 0 addr so router custody
      ])
      planner.addCommand(
        CommandType.SEAPORT_SELL_721,
        [calldata, cryptoCovens.address, OPENSEA_CONDUIT, id, alice.address],
        true
      )
      planner.addCommand(CommandType.SWEEP, [WETH.address, MSG_SENDER, 0])
      const { commands, inputs } = planner

      const ownerBefore = await cryptoCovens.ownerOf(id)
      const wethBefore = await weth.balanceOf(alice.address)
      const routerWethBefore = await weth.balanceOf(router.address)

      // TODO: replace with permit2 transfer
      await cryptoCovens.transferFrom(alice.address, router.address, id)

      const ethBefore = await ethers.provider.getBalance(alice.address)
      const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, {})).wait()

      const ownerAfter = await cryptoCovens.ownerOf(id)
      const wethAfter = await weth.balanceOf(alice.address)
      const routerWethAfter = await weth.balanceOf(router.address)
      const ethAfter = await ethers.provider.getBalance(alice.address)
      const gasSpent = getTxGasSpent(receipt)
      const ethDelta = ethBefore.sub(ethAfter)

      // owner never changed and is alice still
      expect(ownerBefore).to.eq(ownerAfter)
      expect(wethAfter.eq(wethBefore)).to.be.true // alice does not gain any weth
      expect(routerWethAfter.eq(routerWethBefore)).to.be.true // router does not gain any weth
      expect(ethDelta).to.eq(gasSpent)
    })

    it('reverts if NFT order does not go through', async () => {
      let { advancedOrder: invalidOrder } = getAdvancedOrderParams(seaportOrders[2])
      invalidOrder.signature = '0xdeadbeef'
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        invalidOrder,
        [],
        OPENSEA_CONDUIT_KEY,
        ADDRESS_ZERO, // 0 addr so router custody
      ])
      planner.addCommand(CommandType.SEAPORT_SELL_721, [
        calldata,
        cryptoCovens.address,
        OPENSEA_CONDUIT,
        id,
        alice.address,
      ])
      planner.addCommand(CommandType.SWEEP, [WETH.address, MSG_SENDER, 0])
      const { commands, inputs } = planner

      // TODO: replace with permit2 transfer
      await cryptoCovens.transferFrom(alice.address, router.address, id)

      await expect(router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, {})).to.be.revertedWith(
        'ExecutionFailed(0, "0x8baa579f")'
      )
      // Note that owner here will be the router because the transfer from alice was not part of the commands
      // TODO: check this again after permit2 transfer to ensure that NFT is returned
    })
  })

  describe('Seaport SELL ERC1155 -> ERC20 (WETH)', async () => {
    let weth: ERC20
    const id = 0 // 'gm' burnt toast art

    beforeEach(async () => {
      await resetFork(16387720) // found using cast find-block w/ listing timestamp of order
      await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [ALICE_ADDRESS],
      })
      alice = await ethers.getSigner(ALICE_ADDRESS)
      permit2 = (await deployPermit2()).connect(alice) as Permit2
      router = (await deployUniversalRouter(permit2)).connect(alice) as UniversalRouter
      planner = new RoutePlanner()
      const routerSigner = await ethers.getImpersonatedSigner(router.address)
      weth = new ethers.Contract(WETH.address, ERC20_ABI).connect(routerSigner) as ERC20

      // send 1 eth from alice to router.address to cover gas for weth approval
      await (await alice.sendTransaction({ to: router.address, value: ethers.utils.parseEther('1.0') })).wait()
      // max approve conduit for weth
      await weth.approve(OPENSEA_CONDUIT, ethers.constants.MaxUint256)

      // owner of cameoPass 1155 contract
      const cameoPassOwner = '0x1d522ae2Dff7f5b3Cb24465630a5951aD60C9233'

      // Transfer 1 token from cameoPassOwner to alice to prepare for txn
      await cameoPass
        .connect(await ethers.getImpersonatedSigner(cameoPassOwner))
        .safeTransferFrom(cameoPassOwner, alice.address, id, 1, '0x00')
    })

    it('completes advanced order ERC1155 for WETH', async () => {
      let { advancedOrder, value } = getAdvancedOrderParams(seaportOrders[3], [ItemType.ERC20])
      // We need the amount of 1155 tokens to sell, so we call calculateValue separately
      let amount1155 = calculateValue(advancedOrder.parameters.consideration, [ItemType.ERC1155])
      const params = advancedOrder.parameters
      const wethReceived = BigNumber.from(params.offer[0].startAmount).sub(value)
      // Can add logic to select approval target (conduit or consideration) depending on conduitHash
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        advancedOrder,
        [],
        OPENSEA_CONDUIT_KEY,
        ADDRESS_ZERO, // 0 addr so router custody
      ])
      planner.addCommand(CommandType.SEAPORT_SELL_1155, [
        calldata,
        cameoPass.address,
        OPENSEA_CONDUIT,
        id,
        amount1155,
        alice.address,
      ])
      planner.addCommand(CommandType.SWEEP, [WETH.address, MSG_SENDER, 0])
      const { commands, inputs } = planner

      const wethBefore = await weth.balanceOf(alice.address)
      const offererBalanceBefore = await cameoPass.balanceOf(params.offerer, id)
      const fufillerBalanceBefore = await cameoPass.balanceOf(alice.address, id)

      // put NFT in the router TODO replace with Permit2 721
      await cameoPass.safeTransferFrom(alice.address, router.address, id, amount1155, '0x00')

      const ethBefore = await ethers.provider.getBalance(alice.address)
      const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, {})).wait()

      const offererBalanceAfter = await cameoPass.balanceOf(params.offerer, id)
      const fufillerBalanceAfter = await cameoPass.balanceOf(alice.address, id)
      const wethAfter = await weth.balanceOf(alice.address)
      const ethAfter = await ethers.provider.getBalance(alice.address)
      const gasSpent = getTxGasSpent(receipt)
      const ethDelta = ethBefore.sub(ethAfter)

      // Ensure that the correct amount of NFTs were transferred to the offerer from the fufiller
      expect(fufillerBalanceBefore.sub(amount1155).eq(fufillerBalanceAfter)).to.be.true // fufiller loses
      expect(offererBalanceBefore.add(amount1155).eq(offererBalanceAfter)).to.be.true // offerer gains
      expect(wethAfter.sub(wethBefore)).to.eq(wethReceived)
      expect(ethDelta).to.eq(gasSpent)
    })

    it('revertable order returns ERC1155 to user on revert', async () => {
      let { advancedOrder: invalidOrder } = getAdvancedOrderParams(seaportOrders[3], [ItemType.ERC20])
      invalidOrder.signature = '0xdeadbeef'
      let amount1155 = calculateValue(invalidOrder.parameters.consideration, [ItemType.ERC1155])
      const params = invalidOrder.parameters
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        invalidOrder,
        [],
        OPENSEA_CONDUIT_KEY,
        ADDRESS_ZERO, // 0 addr so router custody
      ])
      planner.addCommand(
        CommandType.SEAPORT_SELL_1155,
        [calldata, cameoPass.address, OPENSEA_CONDUIT, id, amount1155, alice.address],
        true
      )
      planner.addCommand(CommandType.SWEEP, [WETH.address, MSG_SENDER, 0])
      const { commands, inputs } = planner

      const wethBefore = await weth.balanceOf(alice.address)
      const offererBalanceBefore = await cameoPass.balanceOf(params.offerer, id)
      const fufillerBalanceBefore = await cameoPass.balanceOf(alice.address, id)

      // put NFT in the router TODO replace with Permit2 721
      await cameoPass.safeTransferFrom(alice.address, router.address, id, amount1155, '0x00')

      const ethBefore = await ethers.provider.getBalance(alice.address)
      const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, {})).wait()

      const offererBalanceAfter = await cameoPass.balanceOf(params.offerer, id)
      const fufillerBalanceAfter = await cameoPass.balanceOf(alice.address, id)
      const wethAfter = await weth.balanceOf(alice.address)
      const ethAfter = await ethers.provider.getBalance(alice.address)
      const gasSpent = getTxGasSpent(receipt)
      const ethDelta = ethBefore.sub(ethAfter)

      // Both offerer and fufiller balances are the same
      expect(fufillerBalanceBefore.eq(fufillerBalanceAfter)).to.be.true 
      expect(offererBalanceBefore.eq(offererBalanceAfter)).to.be.true
      expect(wethAfter).to.eq(wethBefore) // no weth was transferred
      expect(ethDelta).to.eq(gasSpent)
    })

    it('reverts if ERC1155 order does not go through', async () => {
      let { advancedOrder: invalidOrder } = getAdvancedOrderParams(seaportOrders[3], [ItemType.ERC20])
      invalidOrder.signature = '0xdeadbeef'
      let amount1155 = calculateValue(invalidOrder.parameters.consideration, [ItemType.ERC1155])
      const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
        invalidOrder,
        [],
        OPENSEA_CONDUIT_KEY,
        ADDRESS_ZERO, // 0 addr so router custody
      ])
      planner.addCommand(CommandType.SEAPORT_SELL_1155, [
        calldata,
        cameoPass.address,
        OPENSEA_CONDUIT,
        id,
        amount1155,
        alice.address,
      ])
      planner.addCommand(CommandType.SWEEP, [WETH.address, MSG_SENDER, 0])
      const { commands, inputs } = planner

      // put NFT in the router TODO replace with Permit2 721
      await cameoPass.safeTransferFrom(alice.address, router.address, id, amount1155, '0x00')

      await expect(router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, {})).to.be.revertedWith(
        'ExecutionFailed(0, "0x8baa579f")'
      )
      // Note that owner here will be the router because the transfer from alice was not part of the commands
      // TODO: check this again after permit2 transfer to ensure that NFT is returned
    })
  })
})
