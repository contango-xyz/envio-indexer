import { FillItem, Lot, Position, handlerContext } from "generated";
import { createIdForLot } from "../utils/ids";
import { max, mulDiv } from "../utils/math-helpers";
import { Mutable, ReturnPromiseType } from "../utils/types";

export enum AccountingType {
  Long = 'Long',
  Short = 'Short'
}

export type GenericEvent = {
  chainId: number
  blockNumber: number
  transactionHash: string
  blockTimestamp: number
  logIndex: number
}

export const initialiseLot = ({ event, position, accountingType, size, fillItem }: { fillItem: Mutable<Pick<FillItem, 'realisedPnl_short' | 'realisedPnl_long' | 'cashflowBase'>>; size: bigint; accountingType: AccountingType; event: GenericEvent; position: Position; }) => {
  const { chainId, blockNumber, transactionHash, blockTimestamp } = event
  const id = createIdForLot({ chainId, positionId: position.positionId, blockNumber, accountingType })

  const lot: Lot ={
    id,
    chainId,
    positionId: position.positionId,
    createdAtBlock: blockNumber,
    closedAtBlock: undefined,
    createdAtTimestamp: blockTimestamp,
    createdAtTransactionHash: transactionHash,
    accountingType,

    cashflowInCollateralToken: fillItem.cashflowBase,

    size,
    grossSize: size,

    openCost: 0n,
    grossOpenCost: 0n,

    owner: position.owner,

    nextLotId: undefined
  }

  return lot
}


export const allocateFundingCostToLots = async ({ lots, fundingCostToSettle }: { lots: Lot[]; fundingCostToSettle: bigint }) => {

  let remainingFundingCost = fundingCostToSettle
  const aggregateOpenCost = lots.reduce((acc, lot) => acc + lot.openCost, 0n)

  lots = lots.map((lot, idx) => {
    const isLastLot = idx === lots.length - 1

    const shareOfFundingCost = isLastLot ? remainingFundingCost : mulDiv(fundingCostToSettle, lot.openCost, aggregateOpenCost)
    remainingFundingCost -= shareOfFundingCost
    return {
      ...lot,
      openCost: lot.openCost + shareOfFundingCost
    }
  })

  return lots
}

export const allocateFundingProfitToLots = async ({ lots, fundingProfitToSettle }: { lots: Lot[]; fundingProfitToSettle: bigint }) => {

  let remainingFundingProfit = fundingProfitToSettle
  const aggregateSize = lots.reduce((acc, lot) => acc + lot.size, 0n)

  const updatedLots = lots.map((lot, idx) => {
    const isLastLot = idx === lots.length - 1

    const shareOfFundingProfit = isLastLot ? remainingFundingProfit : mulDiv(fundingProfitToSettle, lot.size, aggregateSize)
    remainingFundingProfit -= shareOfFundingProfit
    return {
      ...lot,
      size: lot.size + shareOfFundingProfit
    }
  })

  return updatedLots

}

export const handleSizeDelta = ({
  position,
  fillItem,
  lots,
  accountingType,
  sizeDelta,
  ...event
}: GenericEvent & {
  fillItem: Mutable<Pick<FillItem, 'realisedPnl_short' | 'realisedPnl_long' | 'cashflowBase'>>;
  position: Position;
  lots: Mutable<Lot>[];
  accountingType: AccountingType;
  sizeDelta: bigint;
}) => {

  if (sizeDelta > 0n) {
    return [...lots, initialiseLot({ size: sizeDelta, fillItem, accountingType, event: event, position })]
  } else if (sizeDelta < 0n) {
    // realise pnl for the lots that are being closed
    let remainingSizeDelta = sizeDelta
    return lots.map((lot) => {
      if (remainingSizeDelta > 0n) return lot
      const newLot = { ...lot }
      const closedSize = max(-lot.size, remainingSizeDelta)

      const grossClosedSize = mulDiv(closedSize, lot.grossSize, lot.size)

      newLot.size += closedSize
      newLot.grossSize += grossClosedSize
      remainingSizeDelta -= closedSize

      const closedCost = mulDiv(lot.openCost, closedSize, lot.size)
      const grossClosedCost = mulDiv(lot.grossOpenCost, grossClosedSize, lot.grossSize)

      newLot.openCost += closedCost
      newLot.grossOpenCost += grossClosedCost

      // pretend like this we're closing this amount, and getting 0 units out of the tx, meaning it's a 100% loss
      // this will be adjusted when processing cashflow/debtDelta so the end result is correct
      if (accountingType === AccountingType.Long) {
        fillItem.realisedPnl_long += closedCost
      } else {
        const closedCashflow = mulDiv(closedSize, newLot.cashflowInCollateralToken, lot.size)
        newLot.cashflowInCollateralToken += closedCashflow
        fillItem.realisedPnl_short += closedCost - closedCashflow
      }

      if (closedSize === -lot.size) {
        newLot.closedAtBlock = event.blockNumber
      }

      return newLot
    })
  } else return lots
}

export const handleCostDelta = ({ lots, fillItem, costDelta, accountingType }: { fillItem: Mutable<Pick<FillItem, 'realisedPnl_short' | 'realisedPnl_long' | 'cashflowBase'>>; lots: Mutable<Lot>[]; costDelta: bigint; accountingType: AccountingType }) => {
  // MUTATES THE LOTS AND POSITION
  if (costDelta > 0n) {
    const unchangedLots = lots.slice(0, lots.length - 1)
    const lastLot = lots[lots.length - 1]
    if (!lastLot) return lots
    return [...unchangedLots, { ...lastLot, openCost: lastLot.openCost + costDelta, grossOpenCost: lastLot.grossOpenCost + costDelta }]
  } else {
    if (accountingType === AccountingType.Long) {
      fillItem.realisedPnl_long -= costDelta
    } else {
      fillItem.realisedPnl_short -= costDelta
    }
  }

  return lots
}


export const loadLots = async ({ position, context }: { position: Position; context: handlerContext }) => {

  let nextLongLotId = position.firstLotId_long
  let longLots: Lot[] = []

  while (true) {
    const lotMaybe = await context.Lot.get(nextLongLotId)
    if (lotMaybe) {
      longLots.push(lotMaybe)
      if (!lotMaybe.nextLotId) break
      nextLongLotId = lotMaybe.nextLotId
    } else {
      break
    }
  }

  let nextShortLotId = position.firstLotId_short
  let shortLots: Lot[] = []

  while (true) {
    const lotMaybe = await context.Lot.get(nextShortLotId)
    if (lotMaybe) {
      shortLots.push(lotMaybe)
      if (!lotMaybe.nextLotId) break
      nextShortLotId = lotMaybe.nextLotId
    } else {
      break
    }
  }

  return { longLots, shortLots }
}

export const saveLots = ({ lots, context }: { lots: ReturnPromiseType<typeof loadLots>['longLots'] | ReturnPromiseType<typeof loadLots>['shortLots']; context: handlerContext }) => {
  lots.forEach(lot => {
    context.Lot.set(lot)
  })
}