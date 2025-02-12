import { Lot, Position, handlerContext } from "generated";
import { getPosition } from "../utils/common";
import { createIdForLot } from "../utils/ids";
import { max, mulDiv } from "../utils/math-helpers";
import { ReturnPromiseType } from "../utils/types";


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

export const initialiseLot = ({ event, positionId, accountingType, size = 0n, cost = 0n, context, lots }: { lots: Lot[]; size?: bigint; cost?: bigint; accountingType: AccountingType; event: GenericEvent; positionId: string; context: handlerContext }) => {
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

    size,
    grossSize: size,

    openCost: cost,
    grossOpenCost: cost,

    nextLotId: undefined
  }

  if (lots.length > 0) {
    lots[lots.length - 1] = { ...lots[lots.length - 1], nextLotId: lot.id }
  }

  lots.push(lot)

  return lots.map(lot => ({ ...lot }))
}

export const getOrCreateLot = async ({ positionId, accountingType, context, size = 0n, cost = 0n, lots, ...rest }: GenericEvent & { size?: bigint; cost?: bigint; lots: Lot[]; accountingType: AccountingType; chainId: number; positionId: string; context: handlerContext }) => {
  const id = createIdForLot({ chainId: rest.chainId, positionId, blockNumber: rest.blockNumber, accountingType })
  const index = lots.findIndex(lot => lot.id === id)
  if (index !== -1) {
    const lot = lots[index]
    lots[index] = { ...lot, size: lot.size + size, grossSize: lot.grossSize + size, openCost: lot.openCost + cost, grossOpenCost: lot.grossOpenCost + cost }
    return lots
  }

  const res = initialiseLot({ event: rest, positionId, accountingType, context, lots, size, cost })

  return res.map(lot => ({ ...lot }))
}

export const loadLots = async ({ position, context, log = false }: { log?: boolean; position: Position; context: handlerContext }) => {

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

export const allocateFundingCostToLots = async ({ lots, context, fundingCostToSettle }: { lots: Lot[]; fundingCostToSettle: bigint; context: handlerContext }) => {

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

export const allocateFundingProfitToLots = async ({ lots, context, fundingProfitToSettle }: { lots: Lot[]; fundingProfitToSettle: bigint; context: handlerContext }) => {

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

export const handleSizeDelta = async ({ lots, context, position, sizeDelta, accountingType, blockNumber, ...rest }: GenericEvent & { position: ReturnPromiseType<typeof getPosition>; context: handlerContext; lots: Lot[]; sizeDelta: bigint; accountingType: AccountingType }) => {
  // MUTATES THE LOTS AND POSITION

  if (sizeDelta > 0n) {
    lots = await getOrCreateLot({ size: sizeDelta, positionId: position.positionId, accountingType, context, lots, blockNumber, ...rest })
  } else if (sizeDelta < 0n) {
    // realise pnl for the lots that are being closed

    let remainingSizeDelta = sizeDelta
    lots = lots.map((lot) => {
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

  return lots

}

export const handleCostDelta = async ({ lots, context, position, costDelta, accountingType, blockNumber, transactionHash, blockTimestamp }: GenericEvent & { position: ReturnPromiseType<typeof getPosition>; context: handlerContext; lots: ReturnPromiseType<typeof getOrCreateLot>; costDelta: bigint; accountingType: AccountingType }) => {
  // MUTATES THE LOTS AND POSITION
  if (accountingType === AccountingType.Long) {

    if (costDelta > 0n) {
      lots = await getOrCreateLot({ cost: costDelta, positionId: position.positionId, accountingType, context, lots, chainId: position.chainId, blockNumber, transactionHash, blockTimestamp })
    } else {
      position.realisedPnl_long -= costDelta
    }
  } else {
    if (costDelta < 0n) {
      position.realisedPnl_short -= costDelta
    } else if (costDelta > 0n) {
      lots = await getOrCreateLot({ cost: costDelta, positionId: position.positionId, accountingType, context, lots, chainId: position.chainId, blockNumber, transactionHash, blockTimestamp })
    }
  }

  return lots
}


export const processCollateralDelta = async ({ position, context, collateralDelta, lots, ...event }: GenericEvent & { lots: ReturnPromiseType<typeof loadLots>; collateralDelta: bigint; position: Position; context: handlerContext }) => {
  // MUTATES THE LOTS AND POSITION

  lots.longLots = await handleSizeDelta({ lots: lots.longLots, context, position, sizeDelta: collateralDelta, accountingType: AccountingType.Long, ...event })
  lots.shortLots = await handleCostDelta({ lots: lots.shortLots, context, position, costDelta: collateralDelta, accountingType: AccountingType.Short, ...event })

}

export const processDebtDelta = async ({ position, context, debtDelta, lots, ...event }: GenericEvent & { lots: ReturnPromiseType<typeof loadLots>; debtDelta: bigint; position: Position; context: handlerContext }) => {
  // MUTATES THE LOTS AND POSITION

  lots.shortLots = await handleSizeDelta({ lots: lots.shortLots, context, position, sizeDelta: debtDelta, accountingType: AccountingType.Short, ...event })
  lots.longLots = await handleCostDelta({ lots: lots.longLots, context, position, costDelta: debtDelta, accountingType: AccountingType.Long, ...event })
}

// TODO: delete? 
export const processCashflowDelta = async ({ position, context, cashflowDelta, lots, ...event }: GenericEvent & { lots: ReturnPromiseType<typeof loadLots>; cashflowDelta: bigint; position: Position; context: handlerContext }) => {
  // MUTATES THE LOTS AND POSITION

  lots.shortLots = await handleSizeDelta({ lots: lots.shortLots, context, position, sizeDelta: cashflowDelta, accountingType: AccountingType.Short, ...event })
  lots.longLots = await handleCostDelta({ lots: lots.longLots, context, position, costDelta: cashflowDelta, accountingType: AccountingType.Long, ...event })

}

