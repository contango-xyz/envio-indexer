import { ContangoSwapEvent, Position, Token } from "generated";
import { zeroAddress } from "viem";
import { getIMoneyMarketEventsStartBlock } from "../utils/constants";
import { createTokenId, decodeTokenId } from "../utils/getTokenDetails";
import { max, mulDiv } from "../utils/math-helpers";
import { ContangoEvents, EventType, FillItemType, TransferEvent } from "../utils/types";
import { deriveFillItemValuesFromPositionUpsertedEvent } from "./legacy";
import { getMarkPrice } from "../utils/common";

export type PartialFillItem = {
  cashflowSwap?: ContangoSwapEvent;
  cashflow: bigint;
  cashflowToken_id: string;

  tradePrice_long: bigint; // trade price in debt/collateral terms
  tradePrice_short: bigint; // trade price in collateral/debt terms

  collateralDelta: bigint;
  debtDelta: bigint;

  debtCostToSettle: bigint; // debt accrued since last fill event
  lendingProfitToSettle: bigint; // lending profit accrued since last fill event

  fee: bigint;
  feeToken_id?: string;

  liquidationPenalty: bigint;
  fillItemType: FillItemType;

  dust?: {
    value: bigint;
    tokenId: string;
  }
}

const emptyPartialFillItem = (collateralToken: Token): PartialFillItem => ({
  cashflow: 0n,
  cashflowToken_id: collateralToken.id,
  tradePrice_long: 0n,
  tradePrice_short: 0n,
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
          tradePrice_long: mulDiv(event.amountIn, collateralToken.unit, event.amountOut),
          tradePrice_short: mulDiv(event.amountOut, debtToken.unit, event.amountIn),
        }
      }

      if (tokenIn.address === collateralToken.address && tokenOut.address === debtToken.address) {
        return {
          ...existingFillItem,
          tradePrice_long: mulDiv(event.amountOut, collateralToken.unit, event.amountIn),
          tradePrice_short: mulDiv(event.amountIn, debtToken.unit, event.amountOut),
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
      const [from, to] = [event.params.from, event.params.to].map(a => a.toLowerCase())
      const toTrader = [position.owner, zeroAddress].includes(to)
      const fromTrader = [position.owner, zeroAddress].includes(from)
      const cashflow = toTrader ? -event.params.value : event.params.value

      console.log('HERE EGILL transfer event: ', event)

      if (toTrader || fromTrader) {
        // main cashflow event always happens before any dust sweeping events. This means that if the cashflow is already assigned, we know that we're handling a dust sweeping event
        if (existingFillItem.cashflow !== 0n) return { ...existingFillItem, dust: { value: cashflow, tokenId: createTokenId({ chainId: event.chainId, address: event.srcAddress }) } }  
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
  if (partialFillItem.tradePrice_long === 0n || partialFillItem.tradePrice_short === 0n) {
    const markPrice = await getMarkPrice({ chainId: position.chainId, positionId: position.contangoPositionId, blockNumber, debtToken })
    partialFillItem.tradePrice_long = markPrice
    partialFillItem.tradePrice_short = mulDiv(debtToken.unit, collateralToken.unit, markPrice)
  }
  return partialFillItem
}

const _baseToQuote = (partialFillItem: PartialFillItem, collateralToken: Token) => (amount: bigint) => mulDiv(amount, partialFillItem.tradePrice_long, collateralToken.unit)
const _quoteToBase = (partialFillItem: PartialFillItem, collateralToken: Token) => (amount: bigint) => mulDiv(amount, collateralToken.unit, partialFillItem.tradePrice_long)


export const calculateCashflowsAndFee = (partialFillItem: PartialFillItem, debtToken: Token, collateralToken: Token, dustCashflow: { value: bigint, tokenId: string } | undefined) => {
  const { cashflow, cashflowToken_id, fee, feeToken_id } = partialFillItem
  const baseToQuote = _baseToQuote(partialFillItem, collateralToken)
  const quoteToBase = _quoteToBase(partialFillItem, collateralToken)

  const fee_long = feeToken_id === debtToken.id ? fee : baseToQuote(fee)
  const fee_short = feeToken_id === collateralToken.id ? fee : quoteToBase(fee)

  let cashflowQuote = cashflowToken_id === debtToken.id ? cashflow : baseToQuote(cashflow)
  let cashflowBase = cashflowToken_id === collateralToken.id ? cashflow : quoteToBase(cashflow)

  if (dustCashflow) {
    if (dustCashflow.tokenId === collateralToken.id) {
      cashflowBase += dustCashflow.value
      cashflowQuote += baseToQuote(dustCashflow.value)
    } else {
      cashflowQuote += dustCashflow.value
      cashflowBase += quoteToBase(dustCashflow.value)
    }
  }

  const { cashflowSwap } = partialFillItem

  // if there's a cashflowSwap, we need to figure out which is the other token (either base or quote) and add/subtract the amount accordingly
  if (cashflowSwap) {
    if (cashflowSwap.tokenOut_id === debtToken.id) {
      cashflowQuote += cashflowSwap.amountOut
      cashflowBase += baseToQuote(cashflowSwap.amountOut)
    } else if (cashflowSwap.tokenOut_id === collateralToken.id) {
      cashflowBase += cashflowSwap.amountOut
      cashflowQuote += quoteToBase(cashflowSwap.amountOut)
    } else if (cashflowSwap.tokenIn_id === debtToken.id) {
      cashflowQuote -= cashflowSwap.amountIn
      cashflowBase -= baseToQuote(cashflowSwap.amountIn)
    } else if (cashflowSwap.tokenIn_id === collateralToken.id) {
      cashflowBase -= cashflowSwap.amountIn
      cashflowQuote -= quoteToBase(cashflowSwap.amountIn)
    }
  }

  cashflowQuote -= fee_long
  cashflowBase -= fee_short

  return { cashflowQuote, cashflowBase, fee_long, fee_short }
}

