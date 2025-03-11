import { Position } from "generated"
import { max } from "../../utils/math-helpers"
import { CashflowCurrency, CollateralEvent, DebtEvent, FillItemType, PositionUpsertedEvent } from "../../utils/types"
import { OrganisedEvents } from "./eventStore"
import { PriceConverters } from "./prices"

const processDebtEvents = ({ position, debtEvents }: { position: Position; debtEvents: DebtEvent[] }) => {
  return debtEvents.reduce((acc, event) => {
    const debtCostToSettle = max(event.balanceBefore - position.debt, 0n)
    return { debtCostToSettle: acc.debtCostToSettle + debtCostToSettle, debtDelta: acc.debtDelta + event.debtDelta }
  }, { debtCostToSettle: 0n, debtDelta: 0n })
}

const processCollateralEvents = ({ position, collateralEvents }: { position: Position; collateralEvents: CollateralEvent[] }) => {
  return collateralEvents.reduce((acc, event) => {
    const lendingProfitToSettle = max(event.balanceBefore - (position.accruedLendingProfit + position.collateral), 0n)
    return { lendingProfitToSettle: acc.lendingProfitToSettle + lendingProfitToSettle, collateralDelta: acc.collateralDelta + event.collateralDelta }
  }, { lendingProfitToSettle: 0n, collateralDelta: 0n })
}

const calculateDebtFromPositionUpsertedEvent = ({ position, positionUpsertedEvents, converters }: { converters: PriceConverters; position: Position; positionUpsertedEvents: PositionUpsertedEvent[] }) => {
  const { baseToQuote, quoteToBase } = converters
  let debtDelta = 0n
  let debtCostToSettle = 0n

  for (const event of positionUpsertedEvents) {
    const feeInBase = Number(event.feeCcy) === CashflowCurrency.Base ? event.fee : quoteToBase(event.fee)
    if (Number(event.cashflowCcy) === CashflowCurrency.Base) {
      const amountBorrowed = event.quantityDelta - (event.cashflow - feeInBase)
      debtDelta += baseToQuote(amountBorrowed)
    } else {
      const amountOut = baseToQuote(event.quantityDelta - feeInBase)
      debtDelta += amountOut - event.cashflow
    }
  }

  if (position.debt + debtDelta < 0n) {
    // we know this must be a closing fill event
    debtCostToSettle = -position.debt - debtDelta
  }

  return { debtCostToSettle, debtDelta }
}


const calculateDebtValues = ({ position, debtEvents, positionUpsertedEvents, converters }: { converters: PriceConverters; position: Position; debtEvents: DebtEvent[]; positionUpsertedEvents: PositionUpsertedEvent[] }) => {
  const { debtCostToSettle, debtDelta } = processDebtEvents({ position, debtEvents })
  if (debtDelta !== 0n) return { debtCostToSettle, debtDelta }

  const result = calculateDebtFromPositionUpsertedEvent({ position, positionUpsertedEvents, converters })
  return result
}

const calculateCollateralValues = ({ position, collateralEvents, positionUpsertedEvents }: { position: Position; collateralEvents: CollateralEvent[]; positionUpsertedEvents: PositionUpsertedEvent[] }) => {
  const result = processCollateralEvents({ position, collateralEvents })
  if (result.collateralDelta !== 0n) return result

  const collateralDelta = positionUpsertedEvents.reduce((acc, event) => acc + event.quantityDelta, 0n)
  let lendingProfitToSettle = (position.collateral + collateralDelta) <= 0n ? -position.collateral - collateralDelta : 0n

  return { lendingProfitToSettle, collateralDelta }
}

export const calculateDebtAndCollateral = ({ position, debtEvents, collateralEvents, positionUpsertedEvents, converters, liquidationEvents }: OrganisedEvents & { position: Position; converters: PriceConverters }) => {
  if (liquidationEvents.length > 0) {
    const [{ collateralDelta, debtDelta, lendingProfitToSettle, debtCostToSettle }] = liquidationEvents
    const isFullyLiquidated = position.collateral + position.accruedLendingProfit + collateralDelta <= 0n
    return {
      collateralDelta,
      debtDelta,
      lendingProfitToSettle, // still puzzled as to why the tests pass perfectly with this value
      debtCostToSettle, // same here
      fillItemType: isFullyLiquidated ? FillItemType.LiquidatedFully : FillItemType.Liquidated,
    }
  }

  const debtValues = calculateDebtValues({ position, debtEvents, positionUpsertedEvents, converters })
  const collateralValues = calculateCollateralValues({ position, collateralEvents, positionUpsertedEvents })

  const fillItemType = (() => {
    if (position.collateral === 0n) return FillItemType.Opened
    if ((position.collateral + collateralValues.collateralDelta) <= 0n) return FillItemType.Closed
    return FillItemType.Modified
  })()

  return { ...debtValues, ...collateralValues, fillItemType }
}

export type FillItemWithPricesFeesDebtAndCollateral = ReturnType<typeof calculateDebtAndCollateral>
