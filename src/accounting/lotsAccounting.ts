import { genericEvent } from "envio/src/Internal.gen";
import { FillItem, Lot, Position, handlerContext } from 'generated';
import { createIdForLot } from "../utils/ids";
import { max, mulDiv } from "../utils/math-helpers";
import { Mutable } from "../utils/types";

export enum AccountingType {
  Long = 'Long',
  Short = 'Short'
}

export type GenericEvent = genericEvent<{}, { number: number; timestamp: number }, { hash: string }>
export type EventWithPositionId = genericEvent<{ positionId: string }, { number: number; timestamp: number }, { hash: string }>

export const initialiseLot = ({ event, position, accountingType, size, cost }: { size: bigint; cost: bigint; accountingType: AccountingType; event: GenericEvent; position: Position; }) => {
  const { chainId, block: { number: blockNumber }, transaction: { hash: transactionHash }, block: { timestamp: blockTimestamp } } = event

  const lot: Lot ={
    id: 'unknown', // a lot should never be saved with an unknown id!
    chainId,
    contangoPositionId: position.contangoPositionId,
    createdAtBlock: blockNumber,
    closedAtBlock: undefined,
    createdAtTimestamp: blockTimestamp,
    createdAtTransactionHash: transactionHash,
    accountingType,

    cashflowInCollateralToken: 0n,

    size,
    grossSize: size,

    openCost: cost,
    grossOpenCost: cost,

    position_id: position.id,
    instrument_id: position.instrument_id,
  }

  return lot
}


export const allocateFundingCostToLots = async ({ lots, fundingCostToSettle }: { lots: Lot[]; fundingCostToSettle: bigint }) => {
  if (fundingCostToSettle === 0n) return lots

  let remainingFundingCost = fundingCostToSettle
  const aggregateOpenCost = lots.reduce((acc, lot) => acc + lot.openCost, 0n)

  lots = lots.map((lot, idx) => {
    const isLastLot = idx === lots.length - 1

    const shareOfFundingCost = isLastLot ? remainingFundingCost : mulDiv(fundingCostToSettle, lot.openCost, aggregateOpenCost)
    remainingFundingCost -= shareOfFundingCost
    return {
      ...lot,
      openCost: lot.openCost - shareOfFundingCost
    }
  })

  return lots
}

export const allocateFundingProfitToLots = async ({ lots, fundingProfitToSettle }: { lots: Lot[]; fundingProfitToSettle: bigint }) => {
  if (fundingProfitToSettle === 0n) return lots

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

export const handleCloseSize = ({
  position,
  fillItem,
  lots,
  accountingType,
  sizeDelta,
  closedCostRef,
  ...event
}: GenericEvent & {
  fillItem: Mutable<Pick<FillItem, 'realisedPnl_short' | 'realisedPnl_long' | 'cashflowBase'>>;
  position: Position;
  lots: Mutable<Lot>[];
  accountingType: AccountingType;
  sizeDelta: bigint;
  closedCostRef: Mutable<{ value: bigint }>;
}) => {

  // realise pnl for the lots that are being closed
  let remainingSizeDelta = sizeDelta
  return lots.map((lot) => {
    if (remainingSizeDelta === 0n) return lot
    const newLot = { ...lot }
    const closedSize = max(-lot.size, remainingSizeDelta)
    const grossClosedSize = mulDiv(closedSize, lot.grossSize, lot.size)

    newLot.size += closedSize
    newLot.grossSize += grossClosedSize
    remainingSizeDelta -= closedSize

    const closedCost = mulDiv(lot.openCost, closedSize, lot.size)
    closedCostRef.value += closedCost
    const grossClosedCost = mulDiv(lot.grossOpenCost, grossClosedSize, lot.grossSize)

    newLot.openCost += closedCost
    newLot.grossOpenCost += grossClosedCost

    if (closedSize === -lot.size) {
      newLot.closedAtBlock = event.block.number
    }

    return newLot
  })

}

export const handleCostDelta = ({ lots, fillItem, costDelta, accountingType }: { fillItem: Mutable<Pick<FillItem, 'realisedPnl_short' | 'realisedPnl_long' | 'cashflowBase'>>; lots: Mutable<Lot>[]; costDelta: bigint; accountingType: AccountingType }) => {
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

  return (await Promise.all(Array.from({ length: position.lotCount }, async (_, idx) => {
    return context.Lot.get(createIdForLot({ chainId: position.chainId, positionId: position.contangoPositionId, index: idx }))
  }))).filter((lot): lot is Lot => Boolean(lot))

}

export const saveLots = async ({ lots, context }: { lots: Lot[]; context: handlerContext }) => {
  // Save all lots in parallel
  const openLots = lots.filter((lot) => !lot.closedAtBlock).map((lot, idx) => ({ ...lot, id: createIdForLot({ chainId: lot.chainId, positionId: lot.contangoPositionId, index: idx }) }))
  const openIds = new Set<Lot['id']>(openLots.map(lot => lot.id))

  for (const lot of lots) {
    if (!openIds.has(lot.id)) {
      context.Lot.deleteUnsafe(lot.id)
    }
  }

  await Promise.all(openLots.map((lot) => context.Lot.set(lot)))
}

export const savePosition = async ({ position, lots, context }: { position: Position; lots: Lot[]; context: handlerContext }) => {
  await saveLots({ lots, context })
  context.Position.set({ ...position, lotCount: lots.length })
}
