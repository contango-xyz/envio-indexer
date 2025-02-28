import { ContangoSwapEvent, Lot, Position, Token } from "generated";
import { TRADER_CONSTANT, vaultProxy } from "../ERC20";
import { getMarkPrice } from "../utils/common";
import { getIMoneyMarketEventsStartBlock } from "../utils/constants";
import { createTokenId, decodeTokenId } from "../utils/getTokenDetails";
import { absolute, max, mulDiv } from "../utils/math-helpers";
import { recordEntries, recordFromEntries } from "../utils/record-utils";
import { ContangoEvents, EventType, FillItemType, TransferEvent } from "../utils/types";
import { deriveFillItemValuesFromPositionUpsertedEvent } from "./legacy";
import { AccountingType } from "./lotsAccounting";
import { getLiquidationPenalty } from "../Liquidations/common";

export enum PriceSource {
  TradePrice = 'TradePrice', // regular trades should all have this
  MarkPrice = 'MarkPrice', // trades that only modify collateral or debt should have this
  LastLotPrice = 'LastLotPrice', // trades that should have mark price, but getting the mark price failed, should have this
}

export type PartialFillItem = {
  cashflowSwap?: ContangoSwapEvent;
  cashflow: bigint;
  cashflowToken_id: string;

  swapPrice_long: bigint; // swap price in debt/collateral terms
  swapPrice_short: bigint; // swap price in collateral/debt terms

  priceSource: PriceSource

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

const emptyPartialFillItem = (collateralToken: Token): PartialFillItem => ({
  cashflow: 0n,
  cashflowToken_id: collateralToken.id,
  swapPrice_long: 0n,
  swapPrice_short: 0n,
  priceSource: PriceSource.TradePrice, // default to trade price
  collateralDelta: 0n,
  debtDelta: 0n,
  debtCostToSettle: 0n,
  lendingProfitToSettle: 0n,
  fee: 0n,
  cashflowSwap: undefined,
  liquidationPenalty: 0n,
  fillItemType: FillItemType.Modified,
})

const eventsToFillItem = (position: Position, debtToken: Token, collateralToken: Token, event: ContangoEvents, existingFillItem: PartialFillItem): PartialFillItem => {

  switch (event.eventType) {
    case EventType.DEBT: {
      if (!existingFillItem.debtCostToSettle) {
        const debtCostToSettle = max(event.balanceBefore - (position.debt + position.accruedInterest), 0n)
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
          swapPrice_long: mulDiv(event.amountIn, collateralToken.unit, event.amountOut),
          swapPrice_short: mulDiv(event.amountOut, debtToken.unit, event.amountIn),
        }
      }

      if (tokenIn.address === collateralToken.address && tokenOut.address === debtToken.address) {
        return {
          ...existingFillItem,
          swapPrice_long: mulDiv(event.amountOut, collateralToken.unit, event.amountIn),
          swapPrice_short: mulDiv(event.amountIn, debtToken.unit, event.amountOut),
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
        lendingProfitToSettle: event.lendingProfitToSettle,
        debtCostToSettle: event.debtCostToSettle,
        fillItemType: FillItemType.Liquidated,
      }
    }
    case EventType.TRANSFER: {
      const [from, to] = [event.from, event.to].map(a => a.toLowerCase())
      const toTrader = [position.owner, TRADER_CONSTANT].includes(to)
      const fromTrader = [position.owner, TRADER_CONSTANT].includes(from)
      const cashflow = toTrader ? -event.value : event.value

      if (toTrader || fromTrader) {
        // main cashflow event always happens before any dust sweeping events. This means that if the cashflow is already assigned, we know that we're handling a dust sweeping event
        if (existingFillItem.cashflow !== 0n) return { ...existingFillItem, residualCashflow: { value: cashflow, tokenId: createTokenId({ chainId: event.chainId, address: event.srcAddress }) } }
        if (toTrader) return { ...existingFillItem, cashflow, cashflowToken_id: createTokenId({ chainId: event.chainId, address: event.srcAddress }) }
        if (fromTrader) return { ...existingFillItem, cashflow, cashflowToken_id: createTokenId({ chainId: event.chainId, address: event.srcAddress }) }
      }

      return existingFillItem
    }
    case EventType.POSITION_UPSERTED: {
      if (event.blockNumber <= getIMoneyMarketEventsStartBlock(event.chainId)) {
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

export const eventsToPartialFillItem = (position: Position, debtToken: Token, collateralToken: Token, events: ContangoEvents[]): PartialFillItem => {
  return events.reduce((acc, event) => eventsToFillItem(position, debtToken, collateralToken, event, acc), emptyPartialFillItem(collateralToken))
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

export type MarkPriceResult = {
  price: bigint
  source: PriceSource
}

export const markPriceWithFallback = async ({ lots, chainId, positionId, blockNumber, debtToken, collateralToken }: GetMarkPriceParams): Promise<MarkPriceResult> => {
  const markPrice = await getMarkPrice({ chainId, positionId, blockNumber, debtToken })
  if (markPrice) return { price: markPrice, source: PriceSource.MarkPrice }

  const mostRecentLongLot = lots.filter(lot => lot.accountingType === AccountingType.Long).sort((a, b) => Number(b.createdAtBlock - a.createdAtBlock))[0]
  // if there are no long lots, we can't run the code below
  if (!mostRecentLongLot) throw new Error('Unable to set prices of fill to either mark price or last lot price because there are no long lots!')

  // if mark price is 0, we fall back to using the fill price of the most recent lot (the getMarkPrice function has a catch and returns 0n if it fails)
  console.log(`Unable to get mark price, using last lot price as fallback for ${positionId} on chain ${chainId}`)
  return { price: calculateFillPrice({ fillCost: mostRecentLongLot.grossOpenCost, delta: mostRecentLongLot.grossSize, unit: collateralToken.unit }), source: PriceSource.LastLotPrice }
}

export const withMarkPrice = async ({ position, partialFillItem, blockNumber, debtToken, collateralToken, lots }: { lots: Lot[]; position: Position; partialFillItem: PartialFillItem; blockNumber: number; debtToken: Token; collateralToken: Token; }) => {
  // if the tradePrice is 0, we need to get the markPrice
  if (partialFillItem.swapPrice_long === 0n || partialFillItem.swapPrice_short === 0n) {
    const { price, source } = await markPriceWithFallback({ lots, chainId: position.chainId, positionId: position.contangoPositionId, blockNumber, debtToken, collateralToken })
    partialFillItem.swapPrice_long = price
    partialFillItem.swapPrice_short = mulDiv(debtToken.unit, collateralToken.unit, price)
    partialFillItem.priceSource = source

    if (partialFillItem.fillItemType === FillItemType.Liquidated) {
      partialFillItem.liquidationPenalty = getLiquidationPenalty({ collateralToken, collateralDelta: partialFillItem.collateralDelta, debtDelta: partialFillItem.debtDelta, referencePrice: price })
    }
  }
  return partialFillItem // the fill item will have the price source set to TradePrice by default, so we don't need to assign it here
}

export const calculateDust = (events: ContangoEvents[], partialFillItem: PartialFillItem) => {
  const seed: Record<string, bigint> = {}

  if (partialFillItem.residualCashflow) {
    const { address } = decodeTokenId(partialFillItem.residualCashflow.tokenId)
    seed[address] = partialFillItem.residualCashflow.value
  }

  const record = events
    .filter((e): e is TransferEvent => e.eventType === EventType.TRANSFER) // get only the transfer events
    .filter(e => ([e.to, e.from].includes(vaultProxy))) // only transfers to/from the vault
    .map(e => e.to === vaultProxy ? e : { ...e, value: e.value * -1n })
    .reduce((acc, e) => {
      const prev = acc[e.srcAddress] ?? 0n
      return { ...acc, [e.srcAddress]: prev + e.value }
    }, seed)

  const filtered = recordEntries(record).filter(([_, value]) => value !== 0n)

  return recordFromEntries(filtered)
}

const _baseToQuote = ({ partialFillItem, collateralToken }: { partialFillItem: PartialFillItem; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, partialFillItem.swapPrice_long, collateralToken.unit)
const _quoteToBase = ({ partialFillItem, collateralToken }: { partialFillItem: PartialFillItem; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, collateralToken.unit, partialFillItem.swapPrice_long)

export const calculateCashflowsAndFee = ({ partialFillItem, debtToken, collateralToken, dustRecord }: { dustRecord: ReturnType<typeof calculateDust>; partialFillItem: PartialFillItem; debtToken: Token; collateralToken: Token; }) => {
  const { cashflow: _cashflow, cashflowToken_id, fee, feeToken_id } = partialFillItem
  const baseToQuote = _baseToQuote({ partialFillItem, collateralToken })
  const quoteToBase = _quoteToBase({ partialFillItem, collateralToken })

  if (feeToken_id && feeToken_id !== debtToken.id && feeToken_id !== collateralToken.id) {
    // currently, we're only expecting the fees to be paid in their base or quote. 
    // if we ever change this, this implementation will need to be updated
    throw new Error('Invalid fee token id')
  }

  const fee_long = feeToken_id === debtToken.id ? fee : baseToQuote(fee)
  const fee_short = feeToken_id === collateralToken.id ? fee : quoteToBase(fee)

  let cashflow = _cashflow
  let cashflowQuote = 0n
  let cashflowBase = 0n

  Object.entries(dustRecord).forEach(([address, value]) => {
    if (address === collateralToken.address) {
      cashflowBase -= value
      cashflowQuote -= baseToQuote(value)
    } else if (address === debtToken.address) {
      cashflowQuote -= value
      cashflowBase -= quoteToBase(value)
    }
  })

  const { cashflowSwap } = partialFillItem

  // if there's a cashflowSwap, we need to figure out which is the other token (either base or quote) and add/subtract the amount accordingly
  if (cashflowSwap) {
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
  } else {
    if (cashflowToken_id === debtToken.id) {
      cashflowQuote += cashflow
      cashflowBase += quoteToBase(cashflow)
    } else if (cashflowToken_id === collateralToken.id) {
      cashflowBase += cashflow
      cashflowQuote += baseToQuote(cashflow)
    } else {
      console.log('cashflowToken_id', cashflowToken_id)
      // if we're in this block, something has gone wrong because the if statement above should have caught all the cases
      // if you see this error, the casfhlow swap is not being picked up and added to the fillItem before this function is called
      throw new Error('Invalid cashflow token id')
    }
  }

  cashflowQuote -= fee_long
  cashflowBase -= fee_short

  return { cashflowQuote, cashflowBase, fee_long, fee_short }
}
