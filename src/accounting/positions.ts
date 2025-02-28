import { handlerContext, Position } from "generated";
import { getOrCreateInstrument } from "../utils/common";
import { createIdForPosition } from "../utils/ids";
import { positionIdMapper } from "../utils/mappers";
import { GenericEvent } from "./lotsAccounting";

export const createPosition = async (
  {
    positionId,
    proxyAddress,
    owner,
    context,
    ...event
  }: GenericEvent & {
    proxyAddress: string;
    owner: string;
    positionId: string;
    context: handlerContext
  }
) => {
  const { chainId, block: { number: blockNumber, timestamp }, transaction: { hash: transactionHash } } = event
  const id = createIdForPosition({ ...event, positionId })

  const instrument = await getOrCreateInstrument({ chainId, positionId, context })
  const { mm, number } = positionIdMapper(positionId)
  const newPosition: Position = {
    id,
    chainId,
    proxyAddress,
    contangoPositionId: positionId,
    owner,
    isOpen: true,
    createdAtBlock: blockNumber,
    createdAtTimestamp: timestamp,
    createdAtTransactionHash: transactionHash,
    instrument_id: instrument.id,
    collateral: 0n,
    accruedLendingProfit: 0n,
    debt: 0n,
    accruedInterest: 0n,
    fees_long: 0n,
    fees_short: 0n,
    cashflowBase: 0n,
    cashflowQuote: 0n,
    realisedPnl_long: 0n,
    realisedPnl_short: 0n,
    moneyMarket: mm,
    number,
    lotCount: 0,
    longCost: 0n,
    shortCost: 0n,
  }

  context.Position.set(newPosition)

  return newPosition
}
