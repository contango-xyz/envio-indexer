import { ContangoFeeCollectedEvent, Maestro } from "generated";
import { eventStore } from "./Store";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";
import { eventsReducer } from "./accounting/processEvents";

Maestro.FeeCollected.handler(async ({ event, context }) => {
  const token = await getOrCreateToken({ chainId: event.chainId, address: event.params.token, context })
  const eventId = createEventId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex, eventType: EventType.FEE_COLLECTED })
  const entity: ContangoFeeCollectedEvent = {
    id: eventId,
    chainId: event.chainId,
    positionId: event.params.positionId,
    trader: event.params.trader,
    treasury: event.params.treasury,
    token_id: token.id,
    amount: event.params.amount,
    basisPoints: Number(event.params.basisPoints),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoFeeCollectedEvent.set(entity)
  eventStore.addLog({ eventId, contangoEvent: { ...entity, eventType: EventType.FEE_COLLECTED } })
  
  // fee might be the last event in the tx
  await eventsReducer(
    {
      chainId: event.chainId,
      blockNumber: event.block.number,
      transactionHash: event.transaction.hash,
      positionId: event.params.positionId,
      blockTimestamp: event.block.timestamp,
      logIndex: event.logIndex,
    },
    context
  )
})
