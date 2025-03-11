import { handlerContext, Position } from "generated";
import { getOrCreateInstrument } from "../utils/common";
import { createIdForPosition } from "../utils/ids";
import { positionIdMapper } from "../utils/mappers";
import { GenericEvent } from "./lotsAccounting";

export const createPosition = async (
  {
    contangoPositionId,
    proxyAddress,
    owner,
    context,
    ...event
  }: GenericEvent & {
    proxyAddress: string;
    owner: string;
    contangoPositionId: string;
    context: handlerContext
  }
) => {
  const { chainId, block: { number: blockNumber, timestamp }, transaction: { hash: transactionHash } } = event
  const id = createIdForPosition({ ...event, contangoPositionId })

  const instrument = await getOrCreateInstrument({ chainId, contangoPositionId, context })
  const { mm, number } = positionIdMapper(contangoPositionId)
  const newPosition: Position = {
    id,
    chainId,
    proxyAddress,
    contangoPositionId,
    owner,
    createdAtBlock: blockNumber,
    createdAtTimestamp: timestamp,
    createdAtTransactionHash: transactionHash,
    instrument_id: instrument.id,
    netCollateral: 0n,
    grossCollateral: 0n,
    netDebt: 0n,
    grossDebt: 0n,
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
    migratedTo_id: undefined,
  }

  context.Position.set(newPosition)

  return newPosition
}
