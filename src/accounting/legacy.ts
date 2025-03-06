import { ContangoPositionUpsertedEvent, Position, Token } from "generated";
import { mulDiv } from "../utils/math-helpers";
import { PartialFillItem } from "./helpers";
import { ReferencePriceSource } from "./helpers/prices";
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

  // in case we have a price populated from a swap event, we'll use that
  newFillItem.referencePrice_long = price || newFillItem.referencePrice_long
  newFillItem.referencePrice_short = mulDiv(collateralToken.unit, debtToken.unit, newFillItem.referencePrice_long)
  newFillItem.collateralDelta += quantityDelta
  
  let accruedLendingProfit = 0n

  if ((position.collateral + quantityDelta) <= 0n) {
    // we know this must be a closing fill event
    accruedLendingProfit = -position.collateral - quantityDelta
  }

  // figure out debt delta
  let debtDelta = 0n
  let debtCostToSettle = 0n

  if (newFillItem.referencePrice_long > 0n) {
    if (Number(cashflowCcy) === CashflowCurrency.Base) {
      const amountBorrowed = quantityDelta - cashflow
      debtDelta = mulDiv(amountBorrowed, newFillItem.referencePrice_long, collateralToken.unit)
    } else {
      const amountOut = mulDiv(quantityDelta, price, collateralToken.unit)
      debtDelta = amountOut - cashflow
    }
  }

  if (position.debt + debtDelta < 0n) {
    // we know this must be a closing fill event
    debtCostToSettle = -position.debt - debtDelta
  }

  newFillItem.debtDelta += debtDelta
  newFillItem.lendingProfitToSettle += accruedLendingProfit
  newFillItem.debtCostToSettle += debtCostToSettle
  if (price) {
    newFillItem.referencePriceSource = ReferencePriceSource.SwapPrice
  }

  return newFillItem
};
