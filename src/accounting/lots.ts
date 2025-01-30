import { Lot, Position, handlerContext } from "generated";
import { getOrCreateFillItem } from "../fillReducers";
import { createIdForLot } from "../utils/ids";
import { max, mulDiv } from "../utils/math-helpers";
import { ReturnPromiseType } from "../utils/types";
import { getPosition } from "../utils/common";


export enum AccountingType {
  Long = 'Long',
  Short = 'Short'
}

export type GenericEvent = {
  chainId: number
  blockNumber: number
  transactionHash: string
  blockTimestamp: number
}

export const initialiseLot = ({ event, positionId, accountingType, context, lots }: { lots: Lot[]; accountingType: AccountingType; event: GenericEvent; positionId: string; context: handlerContext }) => {
  const { chainId, blockNumber, transactionHash, blockTimestamp } = event
  const id = createIdForLot({ chainId, positionId, blockNumber, accountingType })

  const lot: Lot ={
    id,
    chainId,
    positionId,
    createdAtBlock: blockNumber,
    closedAtBlock: undefined,
    createdAtTimestamp: blockTimestamp,
    createdAtTransactionHash: transactionHash,
    accountingType,

    size: 0n,
    grossSize: 0n,

    openCost: 0n,
    grossOpenCost: 0n,

    nextLotId: undefined
  }

  if (lots.length > 0) {
    lots[lots.length - 1] = { ...lots[lots.length - 1], nextLotId: lot.id }
  }

  return { ...lot }
}

export const getOrCreateLot = async ({ positionId, accountingType, context, lots, ...rest }: GenericEvent & { lots: Lot[]; accountingType: AccountingType; chainId: number; positionId: string; context: handlerContext }) => {
  const id = createIdForLot({ chainId: rest.chainId, positionId, blockNumber: rest.blockNumber, accountingType })
  const lot = await context.Lot.get(id)
  if (lot) return lot
  return initialiseLot({ event: rest, positionId, accountingType, context, lots })
}

export const loadLots = async ({ position, context }: { position: Position; context: handlerContext }) => {

  let nextLongLotId = position.firstLotId_long
  let longLots: Lot[] = []

  while (true) {
    const lotMaybe = await context.Lot.get(nextLongLotId)
    if (!lotMaybe || !lotMaybe.nextLotId) break
    longLots.push(lotMaybe)
    nextLongLotId = lotMaybe.nextLotId
  }

  let nextShortLotId = position.firstLotId_short
  let shortLots: Lot[] = []

  while (true) {
    const lotMaybe = await context.Lot.get(nextShortLotId)
    if (!lotMaybe || !lotMaybe.nextLotId) break
    shortLots.push(lotMaybe)
    nextShortLotId = lotMaybe.nextLotId
  }

  return { longLots, shortLots }
}

export const saveLots = async ({ lots, context }: { lots: ReturnPromiseType<typeof loadLots>['longLots'] | ReturnPromiseType<typeof loadLots>['shortLots']; context: handlerContext }) => {
  await Promise.all(lots.map(lot => context.Lot.set(lot)))
}

export const allocateFundingCostToLots = async ({ lots, context, fundingCostToSettle }: { lots: Lot[]; fundingCostToSettle: bigint; context: handlerContext }) => {

  let remainingFundingCost = fundingCostToSettle
  const aggregateOpenCost = lots.reduce((acc, lot) => acc + lot.openCost, 0n)

  const updatedLots = lots.map((lot, idx) => {
    const isLastLot = idx === lots.length - 1

    const shareOfFundingCost = isLastLot ? remainingFundingCost : mulDiv(fundingCostToSettle, lot.openCost, aggregateOpenCost)
    remainingFundingCost -= shareOfFundingCost
    return {
      ...lot,
      openCost: lot.openCost + shareOfFundingCost
    }
  })

  return updatedLots
}

export const allocateFundingProfitToLots = async ({ lots, context, fundingProfitToSettle }: { lots: Lot[]; fundingProfitToSettle: bigint; context: handlerContext }) => {

  let remainingFundingProfit = fundingProfitToSettle
  const aggregateSize = lots.reduce((acc, lot) => acc + lot.size, 0n)

  const updatedLots = lots.map((lot, idx) => {
    const isLastLot = idx === lots.length - 1

    const shareOfFundingProfit = isLastLot ? remainingFundingProfit : mulDiv(fundingProfitToSettle, lot.grossSize, aggregateSize)
    remainingFundingProfit -= shareOfFundingProfit
    return {
      ...lot,
      size: lot.size + shareOfFundingProfit
    }
  })

  return updatedLots

}

export const accrueInterest = async ({ 
  lots: { longLots, shortLots }, 
  context, 
  debtCostToSettle = 0n, 
  lendingProfitToSettle = 0n 
}: { 
  lots: ReturnPromiseType<typeof loadLots>;
  debtCostToSettle?: bigint; 
  lendingProfitToSettle?: bigint; 
  context: handlerContext 
}) => {
  if (debtCostToSettle > 0n) {
    longLots = await allocateFundingCostToLots({ lots: longLots, context, fundingCostToSettle: debtCostToSettle })
    shortLots = await allocateFundingProfitToLots({ lots: shortLots, context, fundingProfitToSettle: -debtCostToSettle })
  }

  if (lendingProfitToSettle > 0n) {
    longLots = await allocateFundingProfitToLots({ lots: longLots, context, fundingProfitToSettle: lendingProfitToSettle })
    shortLots = await allocateFundingCostToLots({ lots: shortLots, context, fundingCostToSettle: -lendingProfitToSettle })
  }

  return { longLots, shortLots }
}

export const handleSizeDelta = async ({ lots, context, position, sizeDelta, accountingType, blockNumber, transactionHash, blockTimestamp }: GenericEvent & { position: ReturnPromiseType<typeof getPosition>; context: handlerContext; lots: Lot[]; sizeDelta: bigint; accountingType: AccountingType }) => {
  // MUTATES THE LOTS AND POSITION

  if (sizeDelta > 0n) {
    initialiseLot({ event: { chainId: position.chainId, blockNumber, transactionHash, blockTimestamp }, positionId: position.positionId, accountingType, context, lots })
  } else if (sizeDelta < 0n) {
    // realise pnl for the lots that are being closed

    let remainingSizeDelta = sizeDelta
    lots = lots.map((lot) => {
      const newLot = { ...lot }
      const closedSize = max(-lot.size, remainingSizeDelta)

      newLot.size += closedSize
      newLot.grossSize += closedSize
      remainingSizeDelta -= closedSize

      const closedCost = mulDiv(lot.openCost, closedSize, lot.size)
      newLot.openCost += closedCost
      newLot.grossOpenCost += closedCost

      // pretend like this we're closing this amount, and getting 0 units out of the tx, meaning it's a 100% loss
      // this will be adjusted when processing cashflow/debtDelta so the end result is correct
      if (accountingType === AccountingType.Long) {
        position.realisedPnl_long += closedCost
      } else {
        position.realisedPnl_short += closedCost
      }

      if (closedSize === -lot.size) {
        newLot.closedAtBlock = blockNumber
      }

      return newLot
    })
    
    const newFirstLotId = lots[0]?.id
    if (newFirstLotId) {
      if (accountingType === AccountingType.Long) {
        position.firstLotId_long = newFirstLotId
      } else {
        position.firstLotId_short = newFirstLotId
      }
    }
  }

}

export const handleCostDelta = async ({ lots, context, position, costDelta, accountingType, blockNumber }: GenericEvent & { position: ReturnPromiseType<typeof getPosition>; context: handlerContext; lots: Lot[]; costDelta: bigint; accountingType: AccountingType }) => {
  // MUTATES THE LOTS AND POSITION
  if (accountingType === AccountingType.Long) {
    const id = createIdForLot({ chainId: position.chainId, positionId: position.positionId, blockNumber, accountingType })
    const lotIdx = lots.findIndex(lot => lot.id === id)
    if (lotIdx !== -1) {
      const newLot = { ...lots[lotIdx] }
      newLot.openCost += costDelta
      newLot.grossOpenCost += costDelta
      lots[lotIdx] = newLot
    } else {
      position.realisedPnl_long -= costDelta
    }
  }

}


export const processCollateralDelta = async ({ position, context, collateralDelta, lots, ...event }: GenericEvent & { lots: ReturnPromiseType<typeof loadLots>; collateralDelta: bigint; position: Position; context: handlerContext }) => {
  // MUTATES THE LOTS AND POSITION

  await handleSizeDelta({ lots: lots.longLots, context, position, sizeDelta: collateralDelta, accountingType: AccountingType.Long, ...event })
  await handleCostDelta({ lots: lots.shortLots, context, position, costDelta: collateralDelta, accountingType: AccountingType.Short, ...event })

}

export const processDebtDelta = async ({ position, context, debtDelta, lots, ...event }: GenericEvent & { lots: ReturnPromiseType<typeof loadLots>; debtDelta: bigint; position: Position; context: handlerContext }) => {
  // MUTATES THE LOTS AND POSITION

  await handleSizeDelta({ lots: lots.shortLots, context, position, sizeDelta: debtDelta, accountingType: AccountingType.Short, ...event })
  await handleCostDelta({ lots: lots.longLots, context, position, costDelta: debtDelta, accountingType: AccountingType.Long, ...event })
}

export const processCashflowDelta = async ({ position, context, cashflowDelta, lots, ...event }: GenericEvent & { lots: ReturnPromiseType<typeof loadLots>; cashflowDelta: bigint; position: Position; context: handlerContext }) => {
  // MUTATES THE LOTS AND POSITION

  await handleSizeDelta({ lots: lots.shortLots, context, position, sizeDelta: cashflowDelta, accountingType: AccountingType.Short, ...event })
  await handleCostDelta({ lots: lots.longLots, context, position, costDelta: cashflowDelta, accountingType: AccountingType.Long, ...event })

}

