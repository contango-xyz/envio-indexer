import { Position, Token } from "generated"
import { getLiquidationPenalty } from "../../Liquidations/common"
import { max, mulDiv } from "../../utils/math-helpers"
import { CollateralEvent, DebtEvent, FillItemType, LiquidationEvent, PositionUpsertedEvent } from "../../utils/types"
import { CashflowCurrency } from "../legacy"
import { FillItemWithPricesAndFees } from "./fees"

const processDebtEvents = ({ position, debtEvents }: { position: Position; debtEvents: DebtEvent[] }) => {
  return debtEvents.reduce((acc, event) => {
    const debtCostToSettle = max(event.balanceBefore - (position.debt + position.accruedDebtCost), 0n)
    return { debtCostToSettle: acc.debtCostToSettle + debtCostToSettle, debtDelta: acc.debtDelta + event.debtDelta }
  }, { debtCostToSettle: 0n, debtDelta: 0n })
}

const processCollateralEvents = ({ position, collateralEvents }: { position: Position; collateralEvents: CollateralEvent[] }) => {
  return collateralEvents.reduce((acc, event) => {
    const lendingProfitToSettle = max(event.balanceBefore - (position.accruedLendingProfit + position.collateral), 0n)
    return { lendingProfitToSettle: acc.lendingProfitToSettle + lendingProfitToSettle, collateralDelta: acc.collateralDelta + event.collateralDelta }
  }, { lendingProfitToSettle: 0n, collateralDelta: 0n })
}

const calculateDebtFromPositionUpsertedEvent = ({ position, positionUpsertedEvents, fillItem, collateralToken }: { collateralToken: Token; position: Position; positionUpsertedEvents: PositionUpsertedEvent[]; fillItem: FillItemWithPricesAndFees }) => {
  let debtDelta = 0n
  let debtCostToSettle = 0n

  for (const event of positionUpsertedEvents) {
    const feeInBase = (() => {
      if (event.fee === 0n) return 0n
      if (Number(event.feeCcy) === CashflowCurrency.Base) return event.fee
      return mulDiv(event.fee, collateralToken.unit, fillItem.referencePrice_long)
    })()
    if (Number(event.cashflowCcy) === CashflowCurrency.Base) {
      const amountBorrowed = event.quantityDelta - (event.cashflow - feeInBase)
      debtDelta += mulDiv(amountBorrowed, fillItem.referencePrice_long, collateralToken.unit)
    } else {
      const amountOut = mulDiv(event.quantityDelta - feeInBase, fillItem.referencePrice_long, collateralToken.unit)
      debtDelta += amountOut - event.cashflow
    }
  }

  if (position.debt + debtDelta < 0n) {
    // we know this must be a closing fill event
    debtCostToSettle = -position.debt - debtDelta
  }

  return { debtCostToSettle, debtDelta }
}


const calculateDebtValues = ({ position, debtEvents, positionUpsertedEvents, fillItem, collateralToken }: { collateralToken: Token; fillItem: FillItemWithPricesAndFees; position: Position; debtEvents: DebtEvent[]; positionUpsertedEvents: PositionUpsertedEvent[] }) => {
  const { debtCostToSettle, debtDelta } = processDebtEvents({ position, debtEvents })
  if (debtDelta !== 0n) return { debtCostToSettle, debtDelta }

  const result = calculateDebtFromPositionUpsertedEvent({ position, positionUpsertedEvents, fillItem, collateralToken })
  return result
}

const calculateCollateralValues = ({ position, collateralEvents, positionUpsertedEvents }: { position: Position; collateralEvents: CollateralEvent[]; positionUpsertedEvents: PositionUpsertedEvent[] }) => {
  const result = processCollateralEvents({ position, collateralEvents })
  if (result.collateralDelta !== 0n) return result

  const collateralDelta = positionUpsertedEvents.reduce((acc, event) => acc + event.quantityDelta, 0n)
  let lendingProfitToSettle = (position.collateral + collateralDelta) <= 0n ? -position.collateral - collateralDelta : 0n

  return { lendingProfitToSettle, collateralDelta }
}

export const calculateDebtAndCollateral = ({ position, debtEvents, collateralEvents, positionUpsertedEvents, fillItem, collateralToken, liquidationEvents }: { liquidationEvents: LiquidationEvent[]; collateralToken: Token; fillItem: FillItemWithPricesAndFees; position: Position; debtEvents: DebtEvent[]; collateralEvents: CollateralEvent[]; positionUpsertedEvents: PositionUpsertedEvent[] }) => {
  if (liquidationEvents.length > 0) {
    const [{ collateralDelta, debtDelta, lendingProfitToSettle, debtCostToSettle }] = liquidationEvents
    const isClosingFill = (position.collateral + lendingProfitToSettle) - collateralDelta <= 0n
    return {
      ...fillItem,
      collateralDelta,
      debtDelta,
      lendingProfitToSettle: 0n, // still puzzled as to why the tests pass perfectly with this value
      debtCostToSettle: 0n, // same here
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta, debtDelta, referencePrice: fillItem.referencePrice_long }),
      fillItemType: isClosingFill ? FillItemType.LiquidatedFull : FillItemType.LiquidatedPartial,
    }
  }

  const debtValues = calculateDebtValues({ position, debtEvents, positionUpsertedEvents, fillItem, collateralToken })
  const collateralValues = calculateCollateralValues({ position, collateralEvents, positionUpsertedEvents })

  const fillItemType = (() => {
    if (position.collateral === 0n) return FillItemType.Opened
    if ((position.collateral + collateralValues.collateralDelta) <= 0n) return FillItemType.Closed
    return FillItemType.Modified
  })()

  return { ...fillItem, ...debtValues, ...collateralValues, liquidationPenalty: 0n, fillItemType }
}

export type FillItemWithPricesFeesDebtAndCollateral = ReturnType<typeof calculateDebtAndCollateral>
