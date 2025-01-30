import { ContangoFeeCollectedEvent, ContangoPositionMigratedEvent, StrategyProxy } from "generated";
import { Hex, decodeAbiParameters, parseAbiParameters, toHex } from "viem";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { addFeeEventToFillItem } from "./Maestro";

export const decodeFeeEvent = (data: Hex) => {
  const [treasury, token, addressReceivingFees, amount, basisPoints] = decodeAbiParameters(
    parseAbiParameters("address,address,address,uint256,uint8"),
    data,
  )
  return { treasury, token, addressReceivingFees, amount, basisPoints }
}

StrategyProxy.StragegyExecuted.handler(async ({ event, context }) => {
  const action = event.params.action as Hex

  if (action === toHex("FeeCollected", { size: 32 })) {
    const decoded = decodeFeeEvent(event.params.data as Hex)
    const token = await getOrCreateToken({ chainId: event.chainId, address: decoded.token, context })
    const entity: ContangoFeeCollectedEvent = {
      id: createEventId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex, eventType: EventType.FEE_COLLECTED }),
      eventType: EventType.FEE_COLLECTED,
      chainId: event.chainId,
      positionId: event.params.position1,
      trader: event.params.user,
      treasury: decoded.treasury,
      token_id: token.id,
      amount: decoded.amount,
      basisPoints: decoded.basisPoints,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
    }

    context.ContangoFeeCollectedEvent.set(entity)
    await addFeeEventToFillItem({ feeEvent: entity, context })
  }

  if (action === toHex("PositionMigrated", { size: 32 })) {
    const entity: ContangoPositionMigratedEvent = {
      id: createEventId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex, eventType: EventType.MIGRATED }),
      eventType: EventType.MIGRATED,
      chainId: event.chainId,
      oldPositionId: event.params.position1,
      newPositionId: event.params.position2,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
    }
    context.ContangoPositionMigratedEvent.set(entity)
  }

})