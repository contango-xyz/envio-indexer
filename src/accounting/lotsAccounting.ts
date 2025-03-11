import { genericEvent } from "envio/src/Internal.gen";
import { Lot, Position } from 'generated';
import { absolute, max, min, mulDiv } from "../utils/math-helpers";
import { ContangoEvents, Mutable } from "../utils/types";

export enum AccountingType {
  Long = 'Long',
  Short = 'Short'
}

export type GenericEvent = genericEvent<{}, { number: number; timestamp: number }, { hash: string }>
export type EventWithPositionId = genericEvent<{ positionId: string }, { number: number; timestamp: number }, { hash: string }>

export const initialiseLot = ({ chainId, blockNumber, transactionHash, blockTimestamp, position, accountingType, size, cost }: ContangoEvents & { size: bigint; cost: bigint; accountingType: AccountingType; position: Position; }) => {

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
  lots,
  sizeDelta,
  closedCostRef,
}: {
  lots: Mutable<Lot>[];
  sizeDelta: bigint;
  closedCostRef: Mutable<{ value: bigint }>;
}) => {

  // realise pnl for the lots that are being closed
  let remainingSizeDelta = sizeDelta
  return lots.map((lot) => {
    if (remainingSizeDelta === 0n) return lot
    const newLot = { ...lot }
    const closedSize = remainingSizeDelta > 0n ? min(-lot.size, remainingSizeDelta) : max(-lot.size, remainingSizeDelta)
    const grossClosedSize = mulDiv(closedSize, lot.grossSize, lot.size)

    newLot.size += closedSize
    newLot.grossSize += grossClosedSize
    remainingSizeDelta -= closedSize

    const closedCost = mulDiv(lot.openCost, closedSize, lot.size)
    closedCostRef.value += closedCost
    const grossClosedCost = mulDiv(lot.grossOpenCost, grossClosedSize, lot.grossSize)

    newLot.openCost += closedCost
    newLot.grossOpenCost += grossClosedCost

    return newLot
  })

}

export const handleCostDelta = ({ lots, costDelta }: { lots: Mutable<Lot>[]; costDelta: bigint;}) => {
  if (costDelta > 0n) {
    const unchangedLots = lots.slice(0, lots.length - 1)
    const lastLot = lots[lots.length - 1]
    if (!lastLot) return lots
    return [...unchangedLots, { ...lastLot, openCost: lastLot.openCost + costDelta, grossOpenCost: lastLot.grossOpenCost + costDelta }]
  }

  return lots
}

export const filterLotsByAccountingType = ({ lots }: { lots: Lot[]; }) => {
  let longLots: Mutable<Lot>[] = [...lots.filter(lot => lot.accountingType === AccountingType.Long)] // create a copy
  let shortLots: Mutable<Lot>[] = [...lots.filter(lot => lot.accountingType === AccountingType.Short)] // create a copy

  return { longLots, shortLots }
}

export const allocateInterestToLots = async ({ longLots, shortLots, lendingProfitToSettle, debtCostToSettle }: { longLots: Lot[]; shortLots: Lot[]; lendingProfitToSettle: bigint; debtCostToSettle: bigint; }) => {

  longLots = await allocateFundingProfitToLots({ lots: longLots, fundingProfitToSettle: lendingProfitToSettle }) // size grows, which is a good thing
  longLots = await allocateFundingCostToLots({ lots: longLots, fundingCostToSettle: debtCostToSettle }) // cost grows

  shortLots = await allocateFundingProfitToLots({ lots: shortLots, fundingProfitToSettle: -debtCostToSettle }) // size grows, but it's actually a negative thing because your size is your debt!
  shortLots = await allocateFundingCostToLots({ lots: shortLots, fundingCostToSettle: -lendingProfitToSettle }) // cost grows, but it's actually a good thing because your cost is your collateral!

  return { longLots, shortLots }
}


export const getCollateralAndDebtFromLots = ({ longLots, shortLots }: { longLots: Lot[]; shortLots: Lot[]; }) => {
  const { grossCollateral, netCollateral } = longLots.reduce((acc, lot) => {
    return {
      grossCollateral: acc.grossCollateral + lot.grossSize,
      netCollateral: acc.netCollateral + lot.size,
    }
  }, { grossCollateral: 0n, netCollateral: 0n })

  const { grossDebt, netDebt } = shortLots.reduce((acc, lot) => {
    return {
      grossDebt: acc.grossDebt + lot.grossSize,
      netDebt: acc.netDebt + lot.size,
    }
  }, { grossDebt: 0n, netDebt: 0n })

  return { grossCollateral, netCollateral, grossDebt: absolute(grossDebt), netDebt: absolute(netDebt) }
}

export const updateLots = async ({ lots, collateralDelta, debtDelta, lendingProfitToSettle, debtCostToSettle, position, fillCost_short, fillCost_long, event }: { event: ContangoEvents; fillCost_short: bigint; fillCost_long: bigint; position: Position; debtCostToSettle: bigint; lendingProfitToSettle: bigint; lots: Lot[]; collateralDelta: bigint; debtDelta: bigint; }) => {

  let { longLots, shortLots } = await allocateInterestToLots({ ...filterLotsByAccountingType({ lots }), lendingProfitToSettle, debtCostToSettle })

  const before = getCollateralAndDebtFromLots({ longLots, shortLots })

  let realisedPnl_long = 0n
  let realisedPnl_short = 0n

  if (debtDelta > 0n) {
    // create new short lot if adding debt
    shortLots.push(
      initialiseLot({
        ...event,
        position,
        accountingType: AccountingType.Short,
        size: -debtDelta,
        cost: fillCost_short,
      })
    )
  } else if (debtDelta < 0n) {
    const closedCostRef = { value: 0n }
    shortLots = handleCloseSize({ closedCostRef, lots: shortLots, sizeDelta: -debtDelta })
    realisedPnl_short = fillCost_short - closedCostRef.value
  }

  if (collateralDelta > 0n) {
    // create new long lot if adding collateral
    longLots.push(
      initialiseLot({
        ...event,
        position,
        accountingType: AccountingType.Long,
        size: collateralDelta,
        cost: fillCost_long,
      })
    )
  } else if (collateralDelta < 0n) {
    const closedCostRef = { value: 0n }
    longLots = handleCloseSize({ closedCostRef, lots: longLots, sizeDelta: collateralDelta })
    realisedPnl_long = fillCost_long - closedCostRef.value
  }

  const after = getCollateralAndDebtFromLots({ longLots, shortLots })

  return { longLots, shortLots, realisedPnl_long, realisedPnl_short, before, after }

}