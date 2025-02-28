import { ContangoPositionUpsertedEvent, Position, Token } from "generated";
import { mulDiv } from "../utils/math-helpers";
import { PartialFillItem } from "./helpers";

export enum CashflowCurrency {
  None,
  Base,
  Quote,
}

export const deriveFillItemValuesFromPositionUpsertedEvent = (
  {
    upsertedEvent,
    fillItem,
    position,
    collateralToken,
    debtToken,
  }: {
    collateralToken: Token;
    debtToken: Token;
    upsertedEvent: ContangoPositionUpsertedEvent;
    fillItem: PartialFillItem;
    position: Position;
  }
): PartialFillItem => {
  const { quantityDelta, price, cashflowCcy, cashflow } = upsertedEvent

  const newFillItem = { ...fillItem }

  newFillItem.swapPrice_long = price || newFillItem.swapPrice_long
  newFillItem.swapPrice_short = mulDiv(collateralToken.unit, debtToken.unit, price) || newFillItem.swapPrice_short
  newFillItem.collateralDelta += quantityDelta
  
  let accruedLendingProfit = 0n

  if ((position.collateral + quantityDelta) <= 0n) {
    // we know this must be a closing fill event
    accruedLendingProfit = -position.collateral - quantityDelta
  }

  // figure out debt delta
  let debtDelta = 0n
  let accruedInterest = 0n

  if (price > 0n) {
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      const amountBorrowed = quantityDelta - cashflow
      debtDelta = mulDiv(amountBorrowed, price, collateralToken.unit)
    } else {
      const amountOut = mulDiv(quantityDelta, price, collateralToken.unit)
      debtDelta = amountOut - cashflow
    }
  }

  if (position.debt + debtDelta < 0n) {
    // we know this must be a closing fill event
    accruedInterest = -position.debt - debtDelta
  }

  // probably processing a strategy transaction
  if (quantityDelta === 0n) {
    // edge case where we're not processing a strategy transaction
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      debtDelta -= mulDiv(cashflow, price, collateralToken.unit)
    }
    debtDelta = -cashflow
  }

  newFillItem.debtDelta += debtDelta
  newFillItem.lendingProfitToSettle = accruedLendingProfit
  newFillItem.debtCostToSettle = accruedInterest
  
  return newFillItem
};
