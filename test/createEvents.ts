import { createTokenId } from "../src/utils/getTokenDetails"
import { createEventId } from "../src/utils/ids"
import { CollateralEvent, DebtEvent, EventType, FeeCollectedEvent, SwapEvent } from "../src/utils/types"
import { TransferEvent } from "../src/utils/types"
import { PartialFillItem } from "../src/accounting/processEvents"
import { Token } from "generated"

export const WETH_ADDRESS = '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f'
export const wrsETH_ADDRESS = '0xd2671165570f41bbb3b0097893300b6eb6101e6c'

export const collateralToken: Token = {
  id: '1_0xd2671165570f41bbb3b0097893300b6eb6101e6c',
  address: wrsETH_ADDRESS,
  chainId: 1,
  decimals: 18,
  displaySymbol: 'wrsETH',
  symbol: 'wrsETH',
  unit: BigInt(1e18),
}

export const debtToken: Token = {
  id: '1_0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
  address: WETH_ADDRESS,
  chainId: 1,
  decimals: 18,
  displaySymbol: 'WETH',
  symbol: 'WETH',
  unit: BigInt(1e18),
}

export const emptyPartialFillItem: PartialFillItem = {
  collateralToken,
  debtToken,
  tradePrice_long: BigInt(0),
  tradePrice_short: BigInt(0),
  collateralDelta: BigInt(0),
  debtDelta: BigInt(0),
  debtCostToSettle: BigInt(0),
  lendingProfitToSettle: BigInt(0),
  fee: BigInt(0),
  liquidationPenalty: BigInt(0),
}

export const maestroProxy = "0xa6a147946FACAc9E0B99824870B36088764f969F"
const vaultProxy = '0x3F37C7d8e61C000085AAc0515775b06A3412F36b'

export const TRADER = '0x0000000000000000000000000000000000000002'

export const createTransferEvent = ({ amount, token }: { token: typeof debtToken | typeof collateralToken; amount: bigint }): TransferEvent => {
  const params = (() => {
    if (amount > 0n) return { from: TRADER, to: vaultProxy, value: amount }
    else return { from: vaultProxy, to: TRADER, value: amount }
  })()
  return {
    eventType: EventType.TRANSFER,
    chainId: 1,
    srcAddress: token.address,
    params,
    logIndex: 0,
    transaction: {
      hash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
      from: TRADER,
      to: vaultProxy,
    },
    block: {
      number: 18958249300517,
      timestamp: 18958249300517,
      hash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
    },
  }
}

export const createSwapEvent = ({ amountIn, amountOut, tokenIn, tokenOut }: { amountIn: bigint, amountOut: bigint, tokenIn: string, tokenOut: string }): SwapEvent => {
  return {
    blockNumber: 18958249300517,
    blockTimestamp: 18958249300517,
    id: createEventId({ blockNumber: 18958249300517, eventType: EventType.SWAP_EXECUTED, chainId: 1, transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002', logIndex: 0 }),
    eventType: EventType.SWAP_EXECUTED,
    chainId: 1,
    tokenIn_id: createTokenId({ chainId: 1, address: tokenIn }),
    tokenOut_id: createTokenId({ chainId: 1, address: tokenOut }),
    amountIn,
    amountOut,
    transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
  }
}

export const createCollateralEvent = (args: Partial<CollateralEvent>): CollateralEvent => {
  return {
    eventType: EventType.COLLATERAL,
    chainId: 1,
    balanceBefore: 0n,
    collateralDelta: 0n,
    asset_id: createTokenId({ chainId: 1, address: '0x0000000000000000000000000000000000000000' }),
    transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
    blockNumber: 18958249300517,
    blockTimestamp: 18958249300517,
    id: createEventId({ blockNumber: 18958249300517, eventType: EventType.COLLATERAL, chainId: 1, transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002', logIndex: 0 }),
    positionId: '0x1',
    ...args,
  }
}

export const createDebtEvent = (args: Partial<DebtEvent>): DebtEvent => {
  return {
    eventType: EventType.DEBT,
    chainId: 1,
    balanceBefore: 0n,
    debtDelta: 0n,
    blockNumber: 18958249300517,
    blockTimestamp: 18958249300517,
    id: createEventId({ blockNumber: 18958249300517, eventType: EventType.DEBT, chainId: 1, transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002', logIndex: 0 }),
    positionId: '0x1',
    asset_id: createTokenId({ chainId: 1, address: '0x0000000000000000000000000000000000000000' }),
    transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
    ...args,
  }
}


export const createFeeCollectedEvent = (args: Partial<FeeCollectedEvent>): FeeCollectedEvent => {
  return {
    eventType: EventType.FEE_COLLECTED,
    chainId: 1,
    amount: 0n,
    basisPoints: 0,
    trader: TRADER,
    treasury: '0xFee97c6f9Bce786A08b1252eAc9223057508c760',
    token_id: createTokenId({ chainId: 1, address: '0x0000000000000000000000000000000000000000' }),
    transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
    blockNumber: 18958249300517,
    blockTimestamp: 18958249300517,
    id: createEventId({ blockNumber: 18958249300517, eventType: EventType.FEE_COLLECTED, chainId: 1, transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002', logIndex: 0 }),
    positionId: '0x1',
    ...args,
  }
}

