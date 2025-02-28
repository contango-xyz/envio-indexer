import { ERC20, ERC20_Transfer_event, NonStandardWrappedNative, WrappedNative } from "generated";
import { zeroAddress } from "viem";
import { eventStore } from "./Store";
import { createEventId } from "./utils/ids";
import { EventType, TransferEvent } from "./utils/types";

export const vaultProxy = "0x3f37c7d8e61c000085aac0515775b06a3412f36b"
export const maestroProxy = "0xa6a147946facac9e0b99824870b36088764f969f"
export const TRADER_CONSTANT = "0x0000000000000000000000000000000000000001"

const depositWithdrawalAddresses = [
  vaultProxy,
  maestroProxy, // cashflow in alternative ccy goes to the maestro proxy (or at least did in the past)
]

const depositWithdrawalFilters = depositWithdrawalAddresses.map(address => ([{ from: address }, { to: address }])).flat()
const wrappedNativeWithdrawalFilters = depositWithdrawalAddresses.map(address => ({ src: address }))
const wrappedNativeDepositFilters = depositWithdrawalAddresses.map(address => ({ dst: address }))

const createContangoEvent = (event: ERC20_Transfer_event): TransferEvent => ({
  ...event,
  id: createEventId({ ...event, eventType: EventType.TRANSFER }),
  blockNumber: event.block.number,
  blockTimestamp: event.block.timestamp,
  transactionHash: event.transaction.hash,
  from: event.params.from.toLowerCase(),
  to: event.params.to.toLowerCase(),
  value: event.params.value,
  srcAddress: event.srcAddress.toLowerCase(),
  eventType: EventType.TRANSFER,
})

ERC20.Transfer.handler(async ({ event }) => {
  // add this if to filter out any mint/burn events. The only mint/burn events we would care about are the ones on the wrapped native token (which is handled below)
  if (event.params.from !== zeroAddress && event.params.to !== zeroAddress) {
    eventStore.addLog({ event, contangoEvent: createContangoEvent(event) })
  }
},
{
  wildcard: true,
  eventFilters: depositWithdrawalFilters
})

// we cannot merge this logic into the handler above because there may be other tokens doing burn/mint events as transfers to/from zero address
// need to handle this separately with a sepcific contract address (we're using the wildcard filter above)
NonStandardWrappedNative.Transfer.handler(async ({ event }) => {
  const isMint = event.params.from === zeroAddress
  const isBurn = event.params.to === zeroAddress
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: isMint ? TRADER_CONSTANT : vaultProxy, // hardcode to vaultProxy to handle legacy implmentations where the flows went directly to/from the maestro proxy
      to: isMint ? vaultProxy : TRADER_CONSTANT, // hardcode to vaultProxy to handle legacy implmentations where the flows went directly to/from the maestro proxy
      value: event.params.value
    }
  }

  if (isMint || isBurn) {
    eventStore.addLog({ event, contangoEvent: createContangoEvent(erc20Event) })
  }
},
{
  // funds flowing to/from the maestro proxy is a legacy implementation. Here we only filter for events to/from the deposit/withdrawal addresses that have the zero address as the other party.
  eventFilters: depositWithdrawalAddresses.map(address => ([{ to: zeroAddress, from: address }, { from: zeroAddress, to: address }])).flat()
})

WrappedNative.Deposit.handler(async ({ event }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: TRADER_CONSTANT,
      to: event.params.dst,
      value: event.params.wad
    }
  }

  eventStore.addLog({ event, contangoEvent: createContangoEvent(erc20Event) })
},
{
  eventFilters: wrappedNativeDepositFilters
})

WrappedNative.Withdrawal.handler(async ({ event }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: event.params.src,
      to: TRADER_CONSTANT,
      value: event.params.wad
    }
  }

  eventStore.addLog({ event, contangoEvent: createContangoEvent(erc20Event) })
},
{
  eventFilters: wrappedNativeWithdrawalFilters
})
