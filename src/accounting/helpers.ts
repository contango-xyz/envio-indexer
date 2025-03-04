import { ContangoSwapEvent, Lot, Position, Token } from "generated";
import { TRADER_CONSTANT } from "../ERC20";
import { getLiquidationPenalty } from "../Liquidations/common";
import { getMarkPrice } from "../utils/common";
import { ADDRESSES, getIMoneyMarketEventsStartBlock } from "../utils/constants";
import { createTokenId, decodeTokenId } from "../utils/getTokenDetails";
import { absolute, max, mulDiv } from "../utils/math-helpers";
import { recordEntries, recordFromEntries } from "../utils/record-utils";
import { ContangoEvents, EventType, FillItemType, TransferEvent } from "../utils/types";
import { deriveFillItemValuesFromPositionUpsertedEvent } from "./legacy";
import { AccountingType } from "./lotsAccounting";

export enum ReferencePriceSource {
  SwapPrice = 'SwapPrice', // if there's a base<=>quote swap, we will use that value as the reference price
  MarkPrice = 'MarkPrice', // if there's no swap, we use the mark price (oracle price) as the reference price. trades that modify collateral|debt ONLY should have this
  LastLotPrice = 'LastLotPrice', // trades that should have mark price, but getting the mark price failed, should have this
  None = 'None', // We default to this, and then error if attempting to save a fill item with no reference price
}

export type PartialFillItem = {
  cashflowSwap?: ContangoSwapEvent;

  referencePrice_long: bigint; // swap price in debt/collateral terms
  referencePrice_short: bigint; // swap price in collateral/debt terms
  referencePriceSource: ReferencePriceSource

  collateralDelta: bigint;
  debtDelta: bigint;

  debtCostToSettle: bigint; // debt accrued since last fill event
  lendingProfitToSettle: bigint; // lending profit accrued since last fill event

  fee: bigint;
  feeToken_id?: string;

  liquidationPenalty: bigint;
  fillItemType: FillItemType;

  // this is the cashflow we may get in the other currency than what we received the bulk of the amount in
  residualCashflow?: {
    value: bigint;
    tokenId: string;
  }
}

const emptyPartialFillItem = (): PartialFillItem => ({
  referencePrice_long: 0n,
  referencePrice_short: 0n,
  referencePriceSource: ReferencePriceSource.None, // default to none
  collateralDelta: 0n,
  debtDelta: 0n,
  debtCostToSettle: 0n,
  lendingProfitToSettle: 0n,
  fee: 0n,
  cashflowSwap: undefined,
  liquidationPenalty: 0n,
  fillItemType: FillItemType.Modified,
})

const eventsToFillItem = (position: Position, debtToken: Token, collateralToken: Token, event: ContangoEvents, existingFillItem: PartialFillItem, isLegacy: boolean): PartialFillItem => {
  switch (event.eventType) {
    case EventType.DEBT: {
      if (!existingFillItem.debtCostToSettle) {
        const debtCostToSettle = max(event.balanceBefore - (position.debt + position.accruedDebtCost), 0n)
        return { ...existingFillItem, debtCostToSettle, debtDelta: existingFillItem.debtDelta + event.debtDelta }
      } else return { ...existingFillItem, debtDelta: existingFillItem.debtDelta + event.debtDelta }
    }
    case EventType.COLLATERAL: {
      if (!existingFillItem.lendingProfitToSettle) {
        const lendingProfitToSettle = max(event.balanceBefore - (position.accruedLendingProfit + position.collateral), 0n)
        return { ...existingFillItem, lendingProfitToSettle, collateralDelta: existingFillItem.collateralDelta + event.collateralDelta }
      } else return { ...existingFillItem, collateralDelta: existingFillItem.collateralDelta + event.collateralDelta }
    }
    case EventType.SWAP_EXECUTED: {
      const [tokenIn, tokenOut] = [event.tokenIn_id, event.tokenOut_id].map(decodeTokenId)

      if (tokenIn.address === debtToken.address && tokenOut.address === collateralToken.address) {
        return {
          ...existingFillItem,
          referencePrice_long: mulDiv(event.amountIn, collateralToken.unit, event.amountOut),
          referencePrice_short: mulDiv(event.amountOut, debtToken.unit, event.amountIn),
          referencePriceSource: ReferencePriceSource.SwapPrice,
        }
      }

      if (tokenIn.address === collateralToken.address && tokenOut.address === debtToken.address) {
        return {
          ...existingFillItem,
          referencePrice_long: mulDiv(event.amountOut, collateralToken.unit, event.amountIn),
          referencePrice_short: mulDiv(event.amountIn, debtToken.unit, event.amountOut),
          referencePriceSource: ReferencePriceSource.SwapPrice,
        }
      }

      return { ...existingFillItem, cashflowSwap: event }
    }
    case EventType.FEE_COLLECTED: {
      return {
        ...existingFillItem,
        fee: event.amount,
        feeToken_id: event.token_id,
      }
    }
    case EventType.LIQUIDATION: {
      return {
        ...existingFillItem,
        collateralDelta: event.collateralDelta,
        debtDelta: event.debtDelta,
        lendingProfitToSettle: isLegacy ? 0n : event.lendingProfitToSettle,
        debtCostToSettle: isLegacy ? 0n : event.debtCostToSettle,
        fillItemType: FillItemType.Liquidated,
      }
    }
    case EventType.POSITION_UPSERTED: {
      if (isLegacy) {
        return deriveFillItemValuesFromPositionUpsertedEvent({
          upsertedEvent: event,
          fillItem: existingFillItem,
          position,
          collateralToken,
          debtToken
        })
      }
      return existingFillItem
    }
    default: {
      return existingFillItem
    }
  }
}

export const eventsToPartialFillItem = async ({ position, debtToken, collateralToken, events, lots }: { lots: Lot[]; position: Position; debtToken: Token; collateralToken: Token; events: ContangoEvents[]; }): Promise<PartialFillItem> => {
  const initial = emptyPartialFillItem()
  const nonTransferEvents = events.filter(event => event.eventType !== EventType.TRANSFER)
  const hasPrice = nonTransferEvents.some(event => {
    if (event.eventType === EventType.SWAP_EXECUTED) return true
    if (event.eventType === EventType.POSITION_UPSERTED && event.price) return true
    return false
  })
  const isLegacy = !nonTransferEvents.some(event => event.eventType === EventType.COLLATERAL || event.eventType === EventType.DEBT)
  if (!hasPrice) {
    const { price, source } = await markPriceWithFallback({ lots, chainId: position.chainId, positionId: position.contangoPositionId, blockNumber: events[0].blockNumber, debtToken, collateralToken })
    initial.referencePrice_long = price
    initial.referencePrice_short = mulDiv(debtToken.unit, collateralToken.unit, price)
    initial.referencePriceSource = source
  }

  return events
    .sort((a) => Boolean(a.eventType === EventType.SWAP_EXECUTED) ? -1 : 1)
    .reduce((acc, event) => eventsToFillItem(position, debtToken, collateralToken, event, acc, isLegacy), initial)
}

export const calculateFillPrice = ({ fillCost, delta, unit }: { fillCost: bigint; delta: bigint; unit: bigint; }) => {
  return absolute(mulDiv(fillCost, unit, delta))
}

type GetMarkPriceParams = {
  lots: Lot[]
  chainId: number
  positionId: string
  blockNumber: number
  debtToken: Token
  collateralToken: Token
}

export type ReferencePriceResult = {
  price: bigint
  source: ReferencePriceSource
}

export const markPriceWithFallback = async ({ lots, chainId, positionId, blockNumber, debtToken, collateralToken }: GetMarkPriceParams): Promise<ReferencePriceResult> => {
  const markPrice = await getMarkPrice({ chainId, positionId, blockNumber, debtToken })
  if (markPrice) return { price: markPrice, source: ReferencePriceSource.MarkPrice }

  const mostRecentLongLot = lots.filter(lot => lot.accountingType === AccountingType.Long).sort((a, b) => Number(b.createdAtBlock - a.createdAtBlock))[0]
  // if there are no long lots, we can't run the code below
  if (!mostRecentLongLot) throw new Error('Unable to set prices of fill to either mark price or last lot price because there are no long lots!')

  // if mark price is 0, we fall back to using the fill price of the most recent lot (the getMarkPrice function has a catch and returns 0n if it fails)
  console.log(`Unable to get mark price, using last lot price as fallback for ${positionId} on chain ${chainId}`)
  return { price: calculateFillPrice({ fillCost: mostRecentLongLot.grossOpenCost, delta: mostRecentLongLot.grossSize, unit: collateralToken.unit }), source: ReferencePriceSource.LastLotPrice }
}

export const calculateNetCashflows = (events: ContangoEvents[], targetAddresses: string[], seed = {} as Record<string, bigint>) => {
  const targets = new Set(targetAddresses.map(x => x.toLowerCase()))
  return events.filter((e): e is TransferEvent => e.eventType === EventType.TRANSFER)
    .filter(e => targets.has(e.to.toLowerCase()) || targets.has(e.from.toLowerCase()))
    .map(e => targets.has(e.to.toLowerCase()) ? { ...e, value: e.value * -1n } : e)
    .reduce((acc, e) => {
      const prev = acc[e.srcAddress] ?? 0n
      return { ...acc, [e.srcAddress]: prev + e.value }
    }, seed)
}

export const calculateDust = (events: ContangoEvents[], partialFillItem: PartialFillItem) => {
  const seed: Record<string, bigint> = {}

  if (partialFillItem.residualCashflow) {
    const { address } = decodeTokenId(partialFillItem.residualCashflow.tokenId)
    seed[address] = partialFillItem.residualCashflow.value
  }

  return calculateNetCashflows(events, [ADDRESSES.vaultProxy], seed)
}

const _baseToQuote = ({ partialFillItem, collateralToken }: { partialFillItem: PartialFillItem; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, partialFillItem.referencePrice_long, collateralToken.unit)
const _quoteToBase = ({ partialFillItem, collateralToken }: { partialFillItem: PartialFillItem; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, collateralToken.unit, partialFillItem.referencePrice_long)

export const calculateCashflowsAndFee = ({ partialFillItem, debtToken, collateralToken, cashflows, dustRecord }: { cashflows: Record<string, bigint>; dustRecord?: ReturnType<typeof calculateDust>; partialFillItem: PartialFillItem; debtToken: Token; collateralToken: Token; }) => {
  const { fee, feeToken_id } = partialFillItem
  const baseToQuote = _baseToQuote({ partialFillItem, collateralToken })
  const quoteToBase = _quoteToBase({ partialFillItem, collateralToken })

  if (feeToken_id && feeToken_id !== debtToken.id && feeToken_id !== collateralToken.id) {
    // currently, we're only expecting the fees to be paid in their base or quote. 
    // if we ever change this, this implementation will need to be updated
    throw new Error('Invalid fee token id')
  }

  const fee_long = feeToken_id === debtToken.id ? fee : baseToQuote(fee)
  const fee_short = feeToken_id === collateralToken.id ? fee : quoteToBase(fee)

  let highestCashflowQuote = 0n
  let cashflowToken_id = debtToken.id
  let cashflow = 0n
  let cashflowQuote = 0n
  let cashflowBase = 0n

  // account for any dust left in vault OR dust swept directly to the traders wallet
  // this is important so that we can get accurate relative values for cashflowQuote and cashflowBase, which are used for all accounting calculations
  Object.entries(dustRecord || {}).forEach(([address, value]) => {
    if (address === collateralToken.address) {
      cashflowBase += value
      cashflowQuote += baseToQuote(value)
    } else if (address === debtToken.address) {
      cashflowQuote += value
      cashflowBase += quoteToBase(value)
    }
  })

  Object.entries(cashflows).forEach(([address, value]) => {
    const cashflowQuoteBefore = cashflowQuote
    if (address === collateralToken.address) {
      cashflowBase += value
      cashflowQuote += baseToQuote(value)
    } else if (address === debtToken.address) {
      cashflowQuote += value
      cashflowBase += quoteToBase(value)
    } else {
      if (partialFillItem.cashflowSwap) {
        const { cashflowSwap } = partialFillItem
        if (cashflowSwap.tokenOut_id === debtToken.id) {
          cashflowQuote += cashflowSwap.amountOut
          cashflowBase += quoteToBase(cashflowSwap.amountOut)
        } else if (cashflowSwap.tokenOut_id === collateralToken.id) {
          cashflowBase += cashflowSwap.amountOut
          cashflowQuote += baseToQuote(cashflowSwap.amountOut)
        } else if (cashflowSwap.tokenIn_id === debtToken.id) {
          cashflowQuote -= cashflowSwap.amountIn
          cashflowBase -= quoteToBase(cashflowSwap.amountIn)
        } else if (cashflowSwap.tokenIn_id === collateralToken.id) {
          cashflowBase -= cashflowSwap.amountIn
          cashflowQuote -= baseToQuote(cashflowSwap.amountIn)
        }
      }
    }
    const cashflowQuoteIncrease = cashflowQuote - cashflowQuoteBefore
    if (absolute(cashflowQuoteIncrease) > highestCashflowQuote) {
      highestCashflowQuote = absolute(cashflowQuoteIncrease)
      cashflowToken_id = createTokenId({ address, chainId: collateralToken.chainId })
      cashflow = value
    }
  })

  // because these two values are purely used for accounting, and we want to show realised pnl not accounting for our trading fees, we subtract the fees from the cashflows
  cashflowQuote -= fee_long
  cashflowBase -= fee_short

  return { cashflowQuote, cashflowBase, fee_long, fee_short, cashflowToken_id, cashflow }
}
