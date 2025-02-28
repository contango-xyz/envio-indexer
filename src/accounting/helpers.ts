import { ContangoSwapEvent, Position, Token } from "generated";
import { zeroAddress } from "viem";
import { getIMoneyMarketEventsStartBlock } from "../utils/constants";
import { createTokenId, decodeTokenId } from "../utils/getTokenDetails";
import { max, mulDiv } from "../utils/math-helpers";
import { ContangoEvents, EventType, FillItemType, TransferEvent } from "../utils/types";
import { deriveFillItemValuesFromPositionUpsertedEvent } from "./legacy";
import { getMarkPrice } from "../utils/common";
import { TRADER_CONSTANT, vaultProxy } from "../ERC20";
import { recordEntries, recordFromEntries } from "../utils/record-utils";

export type PartialFillItem = {
  cashflowSwap?: ContangoSwapEvent;
  cashflow: bigint;
  cashflowToken_id: string;

  swapPrice_long: bigint; // swap price in debt/collateral terms
  swapPrice_short: bigint; // swap price in collateral/debt terms

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
  collateralDelta: 0n,
  debtDelta: 0n,
  debtCostToSettle: 0n,
  lendingProfitToSettle: 0n,
  fee: 0n,
  cashflowSwap: undefined,
  liquidationPenalty: 0n,
  fillItemType: FillItemType.Trade,
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
        liquidationPenalty: event.liquidationPenalty,
        fillItemType: FillItemType.Liquidation,
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

export const withMarkPrice = async (position: Position, partialFillItem: PartialFillItem, blockNumber: number, debtToken: Token, collateralToken: Token) => {
  // if the tradePrice is 0, we need to get the markPrice
  if (partialFillItem.swapPrice_long === 0n || partialFillItem.swapPrice_short === 0n) {
    const markPrice = await getMarkPrice({ chainId: position.chainId, positionId: position.contangoPositionId, blockNumber, debtToken })
    partialFillItem.swapPrice_long = markPrice
    partialFillItem.swapPrice_short = mulDiv(debtToken.unit, collateralToken.unit, markPrice)
  }
  return partialFillItem
}

export const calculateDust = (events: ContangoEvents[], partialFillItem: PartialFillItem) => {
  const seed: Record<string, bigint> = {}

  if (partialFillItem.residualCashflow) {
    const { address } = decodeTokenId(partialFillItem.residualCashflow.tokenId)
    seed[address] = partialFillItem.residualCashflow.value
  }

  const record = events
    .filter(e => e.eventType === EventType.TRANSFER) // get only the transfer events
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
      // if we're in this block, something has gone wrong because the if statement above should have caught all the cases
      // if you see this error, the casfhlow swap is not being picked up and added to the fillItem before this function is called
      throw new Error('Invalid cashflow token id')
    }
  }

  cashflowQuote -= fee_long
  cashflowBase -= fee_short

  return { cashflowQuote, cashflowBase, fee_long, fee_short }
}
