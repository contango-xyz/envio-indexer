import { ContangoFeeCollectedEvent, Maestro } from "generated";
import { eventsReducer } from "./accounting/processEvents";
import { eventStore } from "./Store";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";

Maestro.FeeCollected.handler(async ({ event, context }) => {
  const snapshot = await eventStore.getCurrentPositionSnapshot({ event, context })
  const token = await getOrCreateToken({ chainId: event.chainId, address: event.params.token, context })
  const eventId = createEventId({ ...event, eventType: EventType.FEE_COLLECTED })
  const entity: ContangoFeeCollectedEvent = {
    id: eventId,
    chainId: event.chainId,
    contangoPositionId: event.params.positionId,
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
  eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.FEE_COLLECTED } })

  if (snapshot) {
    // we consider the fee event to be the last event in the tx
    await eventsReducer({ ...snapshot, context })
  }
})
