import { ERC20, ERC20_Transfer_event, WETH } from "generated";
import { eventStore } from "./Store";
import { EventType } from "./utils/types";
import { zeroAddress } from "viem";

export const vaultProxy = "0x3f37c7d8e61c000085aac0515775b06a3412f36b"
export const contangoProxy = "0x6cae28b3d09d8f8fc74ccd496ac986fc84c0c24e"

ERC20.Transfer.handler(async ({ event }) => {
  const [from, to] = [event.params.from, event.params.to].map(a => a.toLowerCase())
  const fromProxy = from === vaultProxy && to !== zeroAddress
  const toProxy = to === vaultProxy && from !== zeroAddress
  if (fromProxy || toProxy) {
    eventStore.addLog({ event, contangoEvent: { ...event, eventType: EventType.TRANSFER } })
  }
},
{
  wildcard: true,
  eventFilters: [
    { to: vaultProxy },
    { from: vaultProxy },
  ]
})

WETH.Deposit.handler(async ({ event }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: zeroAddress, // use zeroAddress to signify trader
      to: event.params.dst,
      value: event.params.wad
    }
  }

  eventStore.addLog({ event, contangoEvent: { ...erc20Event, eventType: EventType.TRANSFER } })
},
{
  wildcard: true,
  eventFilters: [
    { dst: contangoProxy }
  ]
})

WETH.Withdrawal.handler(async ({ event }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: event.params.src,
      to: zeroAddress, // use zeroAddress to signify trader
      value: event.params.wad
    }
  }

  eventStore.addLog({ event, contangoEvent: { ...erc20Event, eventType: EventType.TRANSFER } })
},
{
  wildcard: true,
  eventFilters: [
    { src: vaultProxy }
  ]
})
