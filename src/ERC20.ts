import { ERC20, ERC20_Transfer_event, WETH } from "generated";
import { eventsReducer } from "./accounting/processEvents";
import { eventStore } from "./Store";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";

export const vaultProxy = "0x3f37c7d8e61c000085aac0515775b06a3412f36b"
export const contangoProxy = "0x6cae28b3d09d8f8fc74ccd496ac986fc84c0c24e"
export const TRADER = '0x0000000000000000000000000000000000000001'

ERC20.Transfer.handler(async ({ event, context }) => {
  const eventId = createEventId({ eventType: EventType.TRANSFER, chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex })
  eventStore.addLog({ eventId, contangoEvent: { ...event, eventType: EventType.TRANSFER } })
},
{
  wildcard: true,
  eventFilters: [
    { to: vaultProxy },
    { from: vaultProxy },
    { from: vaultProxy, to: contangoProxy }
  ]
})

WETH.Deposit.handler(async ({ event }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: TRADER,
      to: event.params.dst,
      value: event.params.wad
    }
  }

  const eventId = createEventId({ eventType: EventType.TRANSFER, chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex })
  eventStore.addLog({ eventId, contangoEvent: { ...erc20Event, eventType: EventType.TRANSFER } })
},
{
  wildcard: true,
  eventFilters: [
    { dst: contangoProxy }
  ]
})

WETH.Withdrawal.handler(async ({ event, context }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: event.params.src,
      to: TRADER,
      value: event.params.wad
    }
  }

  const eventId = createEventId({ eventType: EventType.TRANSFER, chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex })
  eventStore.addLog({ eventId, contangoEvent: { ...erc20Event, eventType: EventType.TRANSFER } })

  const positionAndLots = eventStore.getCurrentPosition({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash })
  if (positionAndLots) {
    await eventsReducer(
      {
        ...event,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash,
        blockTimestamp: event.block.timestamp,
        positionId: positionAndLots.position.positionId,
      },
      context
    )
  }
  
  // Cleanup events after processing
  eventStore.cleanup(event.chainId, event.block.number + 1)
},
{
  wildcard: true,
  eventFilters: [
    { src: vaultProxy }
  ]
})
