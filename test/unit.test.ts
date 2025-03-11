import { expect } from 'chai'
import { Position, SpotExecutor_SwapExecuted_event, TestHelpers } from 'generated'
import { describe, it } from 'mocha'
import { Hex, toHex } from 'viem'
import { arbitrum } from 'viem/chains'
import { decodeFeeEvent } from '../src/StrategyProxy'
import { ReferencePriceSource } from '../src/accounting/helpers/prices'
import { AccountingType } from '../src/accounting/lotsAccounting'
import { clients } from '../src/clients'
import { createInstrumentId, getBalancesAtBlock } from '../src/utils/common'
import { createTokenId } from '../src/utils/getTokenDetails'
import { IdForPosition, createIdForPosition } from '../src/utils/ids'
import { absolute, mulDiv } from '../src/utils/math-helpers'
import { FillItemType, ReturnPromiseType } from '../src/utils/types'
import { getTransactionEvents, getTransactionHashes, processTransaction, processTransactionsForPosition } from './testHelpers'
const { MockDb } = TestHelpers

const getFeeEventMaybe = (events: ReturnPromiseType<typeof getTransactionEvents>) => {
  const feeEventMaybe = events.find(event => event?.eventName === 'StragegyExecuted')
  if (feeEventMaybe && toHex("FeeCollected", { size: 32 }) === (feeEventMaybe.args as any).action) {
    return decodeFeeEvent((feeEventMaybe.args as any).data as Hex)
  }
  return null
}

const toThreeDecimals = (value: bigint, unit = 1e18) => {
  return Number(Number(value) / Number(unit)).toFixed(3)
}

const getSwapEventMaybe = (events: ReturnPromiseType<typeof getTransactionEvents>) => {
  const [swapEventMaybe] = events.filter(event => event?.eventName === 'SwapExecuted')
  if (swapEventMaybe) return { ...swapEventMaybe, params: swapEventMaybe.args } as unknown as SpotExecutor_SwapExecuted_event
  return null
}

describe('indexer tests', () => {
  let mockDb: ReturnType<typeof MockDb.createMockDb>
  beforeEach(async () => {
    mockDb = MockDb.createMockDb()
  })

  async function getTokensForPosition(position: Position) {
    const instrument = mockDb.entities.Instrument.get(position.instrument_id)
    if (!instrument) throw new Error('Instrument not found in test!')
    const debtToken = mockDb.entities.Token.get(instrument.debtToken_id)
    if (!debtToken) throw new Error('Debt token not found in test!')
    const collateralToken = mockDb.entities.Token.get(instrument.collateralToken_id)
    if (!collateralToken) throw new Error('Collateral token not found in test!')

    return { debtToken, collateralToken }
  }

  async function highLevelInvariants(id: IdForPosition, label = '') {
    const position = mockDb.entities.Position.get(id)
    if (!position) throw new Error('Position not found in test!')
    const fillItems = mockDb.entities.FillItem.getAll()
    const lots = mockDb.entities.Lot.getAll()
    const { debtToken, collateralToken } = await getTokensForPosition(position)

    const aggregatedQuoteCashflow = fillItems.reduce((acc, fillItem) => acc + fillItem.cashflowQuote, 0n)
    const aggregatedBaseCashflow = fillItems.reduce((acc, fillItem) => acc + fillItem.cashflowBase, 0n)

    expect(position.cashflowQuote).to.equal(aggregatedQuoteCashflow)
    expect(position.cashflowBase).to.equal(aggregatedBaseCashflow)
    expect(lots.length).to.equal(0)
    expect(position.lotCount).to.equal(0)

    for (const fillItem of fillItems) {
      const longTimesShort = mulDiv(fillItem.referencePrice_long, fillItem.referencePrice_short, debtToken.unit)
      const asNumber = Number(longTimesShort) / Number(collateralToken.unit)
      expect(asNumber).to.approximately(1, 0.001)
    }

    expect((Number(position.realisedPnl_long) / Number(debtToken.unit)).toFixed(3)).to.equal((Number(position.cashflowQuote) / Number(debtToken.unit) * -1).toFixed(3))
    expect((Number(position.realisedPnl_short) / Number(collateralToken.unit)).toFixed(3)).to.equal((Number(position.cashflowBase) / Number(collateralToken.unit) * -1).toFixed(3))

    // this function (highLevelInvariants) is only called when the position has been closed
    // any closed position should have realised pnl
    expect(position.realisedPnl_long).to.not.equal(0n)
    expect(position.realisedPnl_short).to.not.equal(0n)

    return position
  }

  async function highLevelInvariantsForLiquidation(id: IdForPosition) {
    const { fillItems, position, debtToken, collateralToken } = await getAssertionValues(id)

    const aggregatedQuoteCashflow = fillItems.reduce((acc, fillItem) => acc + fillItem.cashflowQuote, 0n)
    const aggregatedBaseCashflow = fillItems.reduce((acc, fillItem) => acc + fillItem.cashflowBase, 0n)

    expect(position.cashflowQuote).to.equal(aggregatedQuoteCashflow)
    expect(position.cashflowBase).to.equal(aggregatedBaseCashflow)

    let liquidationPenaltyBase = 0n
    let liquidationPenaltyQuote = 0n

    for (const fillItem of fillItems) {
      // long/short prices should be inverse of each other
      const longTimesShort = mulDiv(fillItem.referencePrice_long, fillItem.referencePrice_short, debtToken.unit)
      const asNumber = Number(longTimesShort) / Number(collateralToken.unit)
      expect(asNumber).to.approximately(1, 0.001)

      if (fillItem.fillItemType === FillItemType.Liquidated) {
        liquidationPenaltyBase += mulDiv(fillItem.realisedPnl_short, fillItem.liquidationPenalty, BigInt(1e4))
        liquidationPenaltyQuote += mulDiv(fillItem.realisedPnl_long, fillItem.liquidationPenalty, BigInt(1e4))
      }
    }

    expect((Number(position.realisedPnl_long) / Number(debtToken.unit)).toFixed(3)).to.equal((Number(position.cashflowQuote) / Number(debtToken.unit) * -1).toFixed(3))
    expect((Number(position.realisedPnl_short) / Number(collateralToken.unit)).toFixed(3)).to.equal((Number(position.cashflowBase) / Number(collateralToken.unit) * -1).toFixed(3))
  }

  async function getAssertionValues(id: IdForPosition) {
    const position = mockDb.entities.Position.get(id)
    if (!position) throw new Error('Position not found in test!')
    const fillItems = mockDb.entities.FillItem.getAll().filter(fillItem => fillItem.position_id === id)
    const lots = mockDb.entities.Lot.getAll().filter(lot => lot.position_id === id)
    const { debtToken, collateralToken } = await getTokensForPosition(position)
    
    return { fillItems, lots, debtToken, collateralToken, position, fillItem: fillItems[fillItems.length - 1] }
  }

  it('RDNT/ETH short - Chain: Arbitrum - Number: #20498', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, contangoPositionId: '0x5745544852444e54000000000000000010ffffffff0000000000000000005012' })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(transactionHashes[i], mockDb)
      const { fillItem, lots, position } = await getAssertionValues(id)

      if (i === 0) {
        const longLot = lots.filter(lot => lot.accountingType === AccountingType.Long)[i]
        const shortLot = lots.filter(lot => lot.accountingType === AccountingType.Short)[i]

        expect(fillItem.collateralDelta).to.equal(39990067205165300n) // 0.03999006721
        expect(fillItem.debtDelta).to.equal(857574179879525749083n) // 857.5741798795

        expect(fillItem.cashflow).to.equal(BigInt(0.02e18))
        expect(fillItem.cashflowQuote).to.equal(858000296925399332723n) // 858.0002969253993
        expect(fillItem.cashflowBase).to.equal(BigInt(0.02e18)) // 0.02

        expect(longLot.openCost).to.equal(-1n * (fillItem.cashflowQuote + fillItem.debtDelta)) // -1666.09835550565
        expect(shortLot.openCost).to.equal(fillItem.collateralDelta - fillItem.cashflowBase) // 0.03999006721 - 0.02 --> 0.01999006721

        expect(fillItem.fillCost_long).to.equal(-(857574179879525749083n + 858000296925399332723n)) // casfhlowQuote + debtDelta (negated)
        expect(fillItem.fillCost_short).to.equal(fillItem.collateralDelta - fillItem.cashflowBase)

        expect(fillItem.referencePrice_long).to.equal(42900014846269966636158n) // 42900.014846269966636158
        expect(fillItem.referencePrice_short).to.equal(23310015243198n) // 0.00002331001524
        // 0.00002331001524 * 42900.014846269966636158 = 1 (perfect inverse of each other)

        expect(fillItem.fillPrice_long).to.equal(42900014846269966636129n) // same as swap price long (tiny precision loss)
        expect(fillItem.fillPrice_short).to.equal(23310015243198n) // same as swap price short (no precision loss)

      } else if (i === 1) {
        expect(fillItem.collateralDelta).to.equal(-40062624496224149n) // 0.0400626245 --> original 0.03999006721 + 0.00007255729 (lending profit)
        expect(fillItem.debtDelta).to.equal(-907050301178798335096n) // 907.0503011788 --> original 857.5741798795 + 49.4761212993 (debt cost)

        expect(fillItem.cashflowQuote).to.equal(-1111911232291604141718n) // -1111.911232291604141718
        expect(fillItem.cashflowBase).to.equal(-22125086346822562n) // -0.02212508635
        expect(fillItem.cashflow).to.equal(-22013913848738841n) // -0.02201391385

        expect(fillItem.fillCost_long).to.equal(2018961533470402476814n) // 2018.9613011788 --> 1111.911 + 907.0503011788
        expect(fillItem.fillPrice_long).to.equal(50395139081831421531339n) // 50395.139081831421531339
        expect(fillItem.referencePrice_long).to.equal(50255678773940172326698n) // 50255.6787739402 (seems like this trade got lucky with some dust in the contract that was sent to it)


        expect(fillItem.realisedPnl_short).to.equal(22125086346822562n - BigInt(0.02e18)) // 0.002013913849
        expect(fillItem.realisedPnl_long).to.equal(1111911232291604141718n - 858000296925399332723n)
      }
    }

    await highLevelInvariants(id)

  })

  it('ARB/DAI long - Chain: Arbitrum - Number: #21272', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, contangoPositionId: '0x4152424441490000000000000000000001ffffffff0200000000000000005318' })
    mockDb = await processTransactionsForPosition(id, mockDb)

    await highLevelInvariants(id)
  })

  interface MigrationTestCase {
    chainId: number
    oldPositionId: string
    newPositionId: string
    description: string
  }

  const simpleMigrationTestCases: MigrationTestCase[] = [
    {
      chainId: 42161,
      oldPositionId: '0x5745544855534443000000000000000001ffffffff0000000000000000005271',
      newPositionId: '0x5745544855534443000000000000000011ffffffff00000000000000000053e2',
      description: 'ETH/USDC.e long - Chain: Arbitrum - Number: #21105'
    },
    // {
    //   chainId: 1,
    //   oldPositionId: '0x7355534465444149000000000000000008ffffffff0000000014000000000052',
    //   newPositionId: '0x7355534465444149000000000000000008ffffffff000000000b000000000070',
    //   description: 'Mainnet migration failing in prod',
    // }
    // {
    //   chainId: 42161,
    //   oldPositionId: '0x5745544855534443000000000000000001ffffffff000000000000000000058f',
    //   newPositionId: '0x5745544855534443000000000000000010ffffffff0000000000000000000590',
    //   description: 'ETH/USDC.e long - chain: Arbitrum #Unknown - blockNumber: 197492876'
    // }
  ]

  simpleMigrationTestCases.forEach(({ chainId, oldPositionId, newPositionId, description }) => {
    it(`Migration test: ${description}`, async function() {
      this.timeout(30000)
      const id = createIdForPosition({ chainId, contangoPositionId: oldPositionId })
      const transactionHashes = await getTransactionHashes(id)
      const positionSnapshots: Position[] = []
      let lotsCountBefore = 0
      let newPositionFound = false

      for (let i = 0; i < transactionHashes.length; i++) {
        mockDb = await processTransaction(transactionHashes[i], mockDb)
        const oldPosition = mockDb.entities.Position.get(id)
        if (!oldPosition) throw new Error('Position not found in test!')
        
        const migratedToId = createIdForPosition({ chainId, contangoPositionId: newPositionId })
        const newPosition = mockDb.entities.Position.get(migratedToId)

        if (newPosition) {
          newPositionFound = true
          const lots = mockDb.entities.Lot.getAll()
          const lotsCountAfterMigration = lots.length
          const eventsInMigrationTransaction = await getTransactionEvents(transactionHashes[i])
          const fillItems = mockDb.entities.FillItem.getAll()
          const positionBeforeMigration = positionSnapshots[positionSnapshots.length - 1]
          const [migrationFillItem] = fillItems.reverse()

          // ensure that the number of lots is the same before and after migration
          expect(lotsCountAfterMigration).to.equal(lotsCountBefore)
          for (const lot of lots) {
            expect(lot.id).to.contain(newPositionId)
          }

          // first assert that the old position has been reset to zero
          expect(oldPosition.netDebt).to.equal(0n)
          expect(oldPosition.grossDebt).to.equal(0n)
          expect(oldPosition.cashflowBase).to.equal(0n)
          expect(oldPosition.cashflowQuote).to.equal(0n)
          expect(oldPosition.realisedPnl_long).to.equal(0n)
          expect(oldPosition.realisedPnl_short).to.equal(0n)
          expect(oldPosition.longCost).to.equal(0n)
          expect(oldPosition.shortCost).to.equal(0n)
          expect(oldPosition.lotCount).to.equal(0)
          expect(oldPosition.netCollateral).to.equal(0n)
          expect(oldPosition.netDebt).to.equal(0n)
          expect(oldPosition.fees_long).to.equal(0n)
          expect(oldPosition.fees_short).to.equal(0n)
          
          // check that the migratedTo_id reference is set correctly
          expect(oldPosition.migratedTo_id).to.equal(newPosition.id)
          
          // ensure that the instrument_id is set correctly
          const [oldInstrumentId, newInstrumentId] = [oldPositionId, newPositionId].map(id => createInstrumentId({ chainId, instrumentId: id}))
          expect(oldPosition.instrument_id).to.equal(oldInstrumentId)
          expect(newPosition.instrument_id).to.equal(newInstrumentId)

          // this test is only intened for basic migrations, not migrations that change the base ccy
          expect(oldPosition.instrument_id).to.equal(newPosition.instrument_id)

          // check that the fillItemTypes are set correctly
          expect(migrationFillItem.fillItemType).to.equal(FillItemType.MigrateLendingMarket)

          // check that the new position has the same collateral and debt as the old position PLUS the interest accrued has been settled
          expect(newPosition.netCollateral).to.equal(positionBeforeMigration.netCollateral + migrationFillItem.lendingProfitToSettle)
          expect(newPosition.grossCollateral).to.equal(newPosition.grossCollateral)
          expect(newPosition.netDebt).to.equal(positionBeforeMigration.netDebt + migrationFillItem.debtCostToSettle)
          expect(newPosition.grossDebt).to.equal(positionBeforeMigration.grossDebt + migrationFillItem.debtCostToSettle)

          // we currently don't have any migrations that have cashflows, but if we ever do, we need to decide where to assign those cashflows (in terms of fill items)
          // if we make the right hand side of the assertion this way, then we'll be alerted to the fact that we need to update the code
          expect(newPosition.cashflowBase).to.equal(positionBeforeMigration.cashflowBase + migrationFillItem.cashflowBase)
          expect(newPosition.cashflowQuote).to.equal(positionBeforeMigration.cashflowQuote + migrationFillItem.cashflowQuote)

          // if/when fees are charged for migrations, we need to assign the fee to either the closing or opening fill item
          // the choice is arbitrary, but we need to be consistent -> I've decided to assign it to the closing fill item
          // Given this, let's first make sure that the opening fill item has no fees
          expect(migrationFillItem.fee_long).to.equal(0n)
          expect(migrationFillItem.fee_short).to.equal(0n)
          expect(migrationFillItem.fee).to.equal(0n)
          expect(migrationFillItem.feeToken_id).to.be.undefined

          const feeEvent = getFeeEventMaybe(eventsInMigrationTransaction)

          // basic assertions about the fee event being set on the closing fill item
          if (feeEvent && feeEvent.amount > 0n) {
            expect(migrationFillItem.fee).to.equal(feeEvent.amount)
            expect(migrationFillItem.fee_long).to.not.equal(0n)
            expect(migrationFillItem.fee_short).to.not.equal(0n)
            expect(migrationFillItem.feeToken_id).to.equal(createTokenId({ chainId, address: feeEvent.token }))
          } else {
            expect(migrationFillItem.fee).to.equal(0n)
            expect(migrationFillItem.fee_long).to.equal(0n)
            expect(migrationFillItem.fee_short).to.equal(0n)
            expect(migrationFillItem.feeToken_id).to.be.undefined
          }

          // then check that the new position has the fees set correctly.
          // the new position's fees should be the sum of the old position's fees and the fees from the migration
          expect(newPosition.fees_long).to.equal(positionBeforeMigration.fees_long + migrationFillItem.fee_long)
          expect(newPosition.fees_short).to.equal(positionBeforeMigration.fees_short + migrationFillItem.fee_short)

          // because this isn't an actual closing fill, it's just being migrated to a different market, it shouldn't have any realised pnl!
          expect(migrationFillItem.realisedPnl_long).to.equal(0n)
          expect(migrationFillItem.realisedPnl_short).to.equal(0n)

          // given that a migration doesn't realise any pnl, the realised pnl fields on the new position should be the same as the old position
          expect(newPosition.realisedPnl_long).to.equal(positionBeforeMigration.realisedPnl_long)
          expect(newPosition.realisedPnl_short).to.equal(positionBeforeMigration.realisedPnl_short)
        }

        positionSnapshots.push(oldPosition)
        lotsCountBefore = mockDb.entities.Lot.getAll().length
      }

      expect(newPositionFound).to.be.true
    })
  })


  const baseCcyMigrationTestCases: MigrationTestCase[] = [
    {
      chainId: 42161,
      oldPositionId: '0x5054657a45544846323457455448000010ffffffff01000000000000000015af',
      newPositionId: '0x657a455448574554480000000000000010ffffffff01000000000000000015d0',
      description: 'PTezETH/ETH long - Chain: Arbitrum - Number: #5551 --> Migrate base ccy'
    }
  ]

  baseCcyMigrationTestCases.forEach(({ chainId, oldPositionId, newPositionId, description }) => {
    it(`Migration test: ${description}`, async function() {
      this.timeout(30000)
      const id = createIdForPosition({ chainId, contangoPositionId: oldPositionId })
      const transactionHashes = await getTransactionHashes(id)
      const positionSnapshots: Position[] = []
      let newPositionFound = false

      for (let i = 0; i < transactionHashes.length; i++) {
        mockDb = await processTransaction(transactionHashes[i], mockDb)
        const oldPosition = mockDb.entities.Position.get(id)
        if (!oldPosition) throw new Error('Position not found in test!')
        
        const migratedToId = createIdForPosition({ chainId, contangoPositionId: newPositionId })
        const newPosition = mockDb.entities.Position.get(migratedToId)

        if (newPosition) {
          newPositionFound = true
          const eventsInMigrationTransaction = await getTransactionEvents(transactionHashes[i])
          const fillItems = mockDb.entities.FillItem.getAll()
          const positionBeforeMigration = positionSnapshots[positionSnapshots.length - 1]
          const [migrationOpenFillItem, migrationCloseFillItem] = fillItems.reverse()
          const lots = mockDb.entities.Lot.getAll()

          // if we're migrating base ccy, we should only have 2 lots after migration (one long and one short)
          expect(lots.length).to.equal(2)

          for (const lot of lots) {
            expect(lot.id).to.contain(newPositionId)
          }

          // first assert that the old position has been reset to zero
          expect(oldPosition.netDebt).to.equal(0n)
          expect(oldPosition.grossDebt).to.equal(0n)
          expect(oldPosition.netCollateral).to.equal(0n)
          expect(oldPosition.grossCollateral).to.equal(0n)
          expect(oldPosition.cashflowBase).to.equal(0n)
          expect(oldPosition.cashflowQuote).to.equal(0n)
          expect(oldPosition.realisedPnl_long).to.equal(0n)
          expect(oldPosition.realisedPnl_short).to.equal(0n)
          expect(oldPosition.longCost).to.equal(0n)
          expect(oldPosition.shortCost).to.equal(0n)
          expect(oldPosition.lotCount).to.equal(0)
          expect(oldPosition.fees_long).to.equal(0n)
          expect(oldPosition.fees_short).to.equal(0n)
          
          // check that the migratedTo_id reference is set correctly
          expect(oldPosition.migratedTo_id).to.equal(newPosition.id)

          // ensure we're updated these on the new position
          expect(newPosition.createdAtBlock).to.be.greaterThan(positionBeforeMigration.createdAtBlock)
          expect(newPosition.createdAtTimestamp).to.be.greaterThan(positionBeforeMigration.createdAtTimestamp)
          expect(newPosition.createdAtTransactionHash).to.not.equal(positionBeforeMigration.createdAtTransactionHash)
          
          // ensure that the instrument_id is set correctly
          const [oldInstrumentId, newInstrumentId] = [oldPositionId, newPositionId].map(id => createInstrumentId({ chainId, instrumentId: id}))
          expect(oldPosition.instrument_id).to.equal(oldInstrumentId)
          expect(newPosition.instrument_id).to.equal(newInstrumentId)

          // this test is only intened for basic migrations, not migrations that change the base ccy
          expect(oldPosition.instrument_id).to.not.equal(newPosition.instrument_id)

          // check that the fillItemTypes are set correctly
          expect(migrationOpenFillItem.fillItemType).to.equal(FillItemType.MigrateBaseCurrencyOpen)
          expect(migrationCloseFillItem.fillItemType).to.equal(FillItemType.MigrateBaseCurrencyClose)

          const swapEvent = getSwapEventMaybe(eventsInMigrationTransaction)

          expect(swapEvent).to.not.be.null
          if (!swapEvent) throw new Error('Swap event not found in test!')

          expect(newPosition.netCollateral).to.equal(swapEvent.params.amountOut)
          expect(newPosition.grossCollateral).to.equal(swapEvent.params.amountOut)
          expect(newPosition.netDebt).to.equal(migrationOpenFillItem.debtDelta)
          expect(newPosition.grossDebt).to.equal(migrationOpenFillItem.debtDelta)

          // cashflow base should be the sum of the old position's cashflow base, converted to the new base ccy
          const expectedCashflowBase = mulDiv(positionBeforeMigration.cashflowBase + migrationCloseFillItem.cashflowBase, swapEvent.params.amountOut, swapEvent.params.amountIn)
          expect(newPosition.cashflowBase).to.equal(expectedCashflowBase)
          expect(newPosition.cashflowQuote).to.equal(positionBeforeMigration.cashflowQuote + migrationCloseFillItem.cashflowQuote + migrationOpenFillItem.cashflowQuote)

          // if/when fees are charged for migrations, we need to assign the fee to either the closing or opening fill item
          // the choice is arbitrary, but we need to be consistent -> I've decided to assign it to the closing fill item
          // Given this, let's first make sure that the opening fill item has no fees
          expect(migrationOpenFillItem.fee_long).to.equal(0n)
          expect(migrationOpenFillItem.fee_short).to.equal(0n)
          expect(migrationOpenFillItem.fee).to.equal(0n)
          expect(migrationOpenFillItem.feeToken_id).to.be.undefined

          const feeEvent = getFeeEventMaybe(eventsInMigrationTransaction)

          // basic assertions about the fee event being set on the closing fill item
          if (feeEvent && feeEvent.amount > 0n) {
            expect(migrationCloseFillItem.fee).to.equal(feeEvent.amount)
            expect(migrationCloseFillItem.fee_long).to.not.equal(0n)
            expect(migrationCloseFillItem.fee_short).to.not.equal(0n)
            expect(migrationCloseFillItem.feeToken_id).to.equal(createTokenId({ chainId, address: feeEvent.token }))
          } else {
            expect(migrationCloseFillItem.fee).to.equal(0n)
            expect(migrationCloseFillItem.fee_long).to.equal(0n)
            expect(migrationCloseFillItem.fee_short).to.equal(0n)
            expect(migrationCloseFillItem.feeToken_id).to.be.undefined
          }

          // then check that the new position has the fees set correctly.
          // the new position's fees should be the sum of the old position's fees and the fees from the migration
          expect(newPosition.fees_long).to.equal(positionBeforeMigration.fees_long + migrationCloseFillItem.fee_long)
          expect(newPosition.fees_short).to.equal(positionBeforeMigration.fees_short + migrationCloseFillItem.fee_short)

          // no cashflows
          expect(migrationOpenFillItem.cashflow).to.equal(0n)
          expect(migrationOpenFillItem.cashflowBase).to.equal(0n)
          expect(migrationOpenFillItem.cashflowQuote).to.equal(0n)

          expect(migrationCloseFillItem.cashflow).to.equal(0n)
          expect(migrationCloseFillItem.cashflowBase).to.equal(0n)
          expect(migrationCloseFillItem.cashflowQuote).to.equal(0n)

          // the fill costs should be the inverse of each other
          expect(migrationOpenFillItem.fillCost_long).to.equal(migrationCloseFillItem.fillCost_long * -1n)
          expect(migrationOpenFillItem.fillCost_short).to.equal(migrationCloseFillItem.fillCost_short * -1n)
          
          // we know the calculation is correct, we just want to make sure the values are populated (no need to test the precise values)
          expect(migrationOpenFillItem.fillPrice_long).to.not.equal(0n)
          expect(migrationOpenFillItem.fillPrice_short).to.not.equal(0n)
          
          // the fill prices should be the same on both fill items
          expect(migrationOpenFillItem.fillPrice_long).to.equal(migrationCloseFillItem.fillPrice_long)
          expect(migrationOpenFillItem.fillPrice_short).to.equal(migrationCloseFillItem.fillPrice_short)

          // both fill items should have the same price source, and the price source should be the fill price
          expect(migrationCloseFillItem.referencePriceSource).to.equal(ReferencePriceSource.MarkPrice)
          expect(migrationOpenFillItem.referencePriceSource).to.equal(ReferencePriceSource.MarkPrice)

          expect(migrationOpenFillItem.referencePrice_long).to.not.equal(0n)
          expect(migrationOpenFillItem.referencePrice_short).to.not.equal(0n)

          // as always, an opening fill item shouldn't have any realised pnl
          expect(migrationOpenFillItem.realisedPnl_long).to.equal(0n)
          expect(migrationOpenFillItem.realisedPnl_short).to.equal(0n)

          // because this isn't an actual closing fill, it's just being migrated to a different market, it shouldn't have any realised pnl!
          expect(migrationCloseFillItem.realisedPnl_long).to.equal(0n)
          expect(migrationCloseFillItem.realisedPnl_short).to.equal(0n)

          // given that a migration doesn't realise any pnl, the realised pnl fields on the new position should be the same as the old position
          expect(newPosition.realisedPnl_long).to.equal(positionBeforeMigration.realisedPnl_long)
          expect(newPosition.realisedPnl_short).to.equal(positionBeforeMigration.realisedPnl_short)
        }

        positionSnapshots.push(oldPosition)
      }

      expect(newPositionFound).to.be.true
    })
  })

  it('Migration from before the PositionMigrated event', async function() {
    this.timeout(30000)
    const oldId = createIdForPosition({ chainId: 42161, contangoPositionId: '0x5745544855534443000000000000000001ffffffff0000000000000000000a17' })
    const newId = createIdForPosition({ chainId: 42161, contangoPositionId: '0x574554485553444300000000000000000bffffffff0000000000000000000ad2' })
    mockDb = await processTransactionsForPosition(oldId, mockDb)
    const fillItems = mockDb.entities.FillItem.getAll()
    const lots = mockDb.entities.Lot.getAll()
    const longLots = lots.filter(lot => lot.accountingType === AccountingType.Long)
    const shortLots = lots.filter(lot => lot.accountingType === AccountingType.Short)

    const fillItem = fillItems.find(item => item.fillItemType === FillItemType.MigrateLendingMarket)
    if (!fillItem) throw new Error('Migration event not found in test!')

    const oldPosition = mockDb.entities.Position.get(oldId)
    if (!oldPosition) throw new Error('Position not found in test!')

    expect(oldPosition.migratedTo_id).to.equal(newId)
    expect(oldPosition.realisedPnl_long).to.equal(0n)
    expect(oldPosition.realisedPnl_short).to.equal(0n)

    expect(fillItem.debtDelta).to.equal(1633n)
    expect(fillItem.collateralDelta).to.equal(0n)
    expect(fillItem.cashflowQuote).to.equal(-1633n) // 0.001633 USDC was sent to the vault
    expect(fillItem.cashflowBase).to.equal(0n)
    expect(fillItem.cashflow).to.equal(0n)
    expect(fillItem.cashflowToken_id).to.be.undefined
    expect(fillItem.fee).to.equal(0n)
    expect(fillItem.fee_long).to.equal(0n)
    expect(fillItem.fee_short).to.equal(0n)
    expect(fillItem.feeToken_id).to.be.undefined
    expect(fillItem.fillItemType).to.equal(FillItemType.MigrateLendingMarket)
    expect(fillItem.fillPrice_long).to.equal(0n)
    expect(fillItem.fillPrice_short).to.equal(0n)
    
    const newPosition = mockDb.entities.Position.get(newId)
    if (!newPosition) throw new Error('New position not found in test!')

    expect(newPosition.id).to.equal(newId)
    expect(newPosition.migratedTo_id).to.equal(undefined)
    expect(newPosition.grossCollateral).to.equal(BigInt(0.009409545711451312e18))
    expect(newPosition.netDebt).to.equal(BigInt(16.350110e6))

    expect(longLots.reduce((acc, lot) => acc + lot.openCost, 0n)).to.equal(newPosition.longCost)
    expect(shortLots.reduce((acc, lot) => acc + lot.openCost, 0n)).to.equal(newPosition.shortCost)

  })

  it('Some random migration', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, contangoPositionId: '0x777374455448574554480000000000001fffffffff0000000005000000004b63' })
    mockDb = await processTransactionsForPosition(id, mockDb)

    const oldPosition = mockDb.entities.Position.get(id)
    if (!oldPosition) throw new Error('Position not found in test!')

    expect(oldPosition.migratedTo_id).to.equal('42161_0x777374455448574554480000000000000effffffff00000000030000000053f9')
    expect(oldPosition.cashflowBase).to.equal(0n)
    expect(oldPosition.cashflowQuote).to.equal(0n)
    expect(oldPosition.realisedPnl_long).to.equal(0n)
    expect(oldPosition.realisedPnl_short).to.equal(0n)
    expect(oldPosition.longCost).to.equal(0n)
    expect(oldPosition.shortCost).to.equal(0n)
    expect(oldPosition.netCollateral).to.equal(0n)
    expect(oldPosition.grossCollateral).to.equal(0n)
    expect(oldPosition.netDebt).to.equal(0n)
    expect(oldPosition.grossDebt).to.equal(0n)
    expect(oldPosition.fees_long).to.equal(0n)
    expect(oldPosition.fees_short).to.equal(0n)
    
    const newPosition = mockDb.entities.Position.get(oldPosition.migratedTo_id!)
    if (!newPosition) throw new Error('New position not found in test!')

    expect(newPosition.migratedTo_id).to.equal(undefined)
    expect(Number(newPosition.netCollateral)).to.be.greaterThan(0)
  })

  it('Short ETH/USDC - 0x leverage', async function() {
    this.timeout(30000)
    const positionId = '0x5553444357455448000000000000000001ffffffff000000000000000000005c'
    const id = createIdForPosition({ chainId: 42161, contangoPositionId: positionId })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(transactionHashes[i], mockDb)
      const fillItems = mockDb.entities.FillItem.getAll()
      const lots = mockDb.entities.Lot.getAll()
      const position = mockDb.entities.Position.get(id)
      if (!position) throw new Error('Position not found in test!')
      const fillItem = fillItems[i]

      if (i === 0) {
        // this position has no debt, and hence no short lots
        expect(lots.length).to.equal(1)
        expect(lots[0].accountingType).to.equal(AccountingType.Long)
        expect(fillItem.fillItemType).to.equal(FillItemType.Opened)
      } else if (i === 1) {
        // this position has debt, and hence a short lot
        expect(position.realisedPnl_long).to.not.equal(0n)
        expect(position.realisedPnl_short).to.equal(0n)
        expect(fillItem.fillCost_short).to.equal(1257072n) // just the fee
        expect(fillItem.fillPrice_short).to.equal(0n)
        expect(fillItem.fillItemType).to.equal(FillItemType.Closed)
      }
    }
  })


  it('ARB/USDC long - Chain: Arbitrum - Number: #5488', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, contangoPositionId: '0x415242555344432e6e0000000000000001ffffffff0200000000000000001570' })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(transactionHashes[i], mockDb)

      const position = mockDb.entities.Position.get(id)
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const fillItem = fillItems[i]

      if (i === 0) {
        expect(fillItem.cashflow).to.equal(BigInt(0.02e18)) // 0.02 ETH
        expect(fillItem.cashflowQuote).to.equal(BigInt(68.027973e6))
        expect(fillItem.cashflowBase).to.equal(80735499391093514082n) // 80.735
        expect(fillItem.referencePrice_long).to.equal(BigInt(0.842603e6))
        expect(fillItem.referencePrice_short).to.equal(1186798527895105998n) // 1 / 0.842603 = 1.186865 (the inverse of the long trade price)
        expect(fillItem.referencePriceSource).to.equal(ReferencePriceSource.SwapPrice)

      } else if (i === 1) {
        expect(fillItem.cashflow).to.equal(-19930869917414180n) // 0.01993086991741418
        expect(fillItem.cashflowBase).to.equal(-80867067518738762881n) // 80.867
        expect(fillItem.cashflowQuote).to.equal(-68250187n) // 68.250187
        expect(fillItem.referencePriceSource).to.equal(ReferencePriceSource.SwapPrice)

        expect(fillItem.realisedPnl_short).to.equal(80867067518738762881n - 80735499391093514082n) // sum of base cashflows

        expect(fillItem.referencePrice_long).to.equal(BigInt(0.843980e6))
        expect(fillItem.fillPrice_long).to.equal(BigInt(0.843980e6))

        expect(fillItem.referencePrice_short).to.equal(1184861656014328796n) // 1 / 0.842603 = 1.18486 (the inverse of the long trade price)
        expect(fillItem.referencePriceSource).to.equal(ReferencePriceSource.SwapPrice)
        expect(fillItem.fillPrice_short).to.equal(1184861653848222336n) // 1 / 0.842603 = 1.18486 (the inverse of the long trade price)

        expect(fillItem.realisedPnl_long).to.equal(222214n) // sum of quote cashflows
        expect(fillItem.realisedPnl_short).to.equal(80867067518738762881n - 80735499391093514082n) // sum of base cashflows
      }
    }

    await highLevelInvariants(id)
  })

  // test with positon that uses new IMoneyMarket events
  it('USDT/USDC - Arbitrum - Using new events (OPEN->REDUCE->CLOSE)', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, contangoPositionId: '0x55534454555344432e6e00000000000011ffffffff00000000000000000058a8' })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(transactionHashes[i], mockDb)

      const { fillItem, lots, position, fillItems } = await getAssertionValues(id)
      if (i === 0) {
        expect(lots.length).to.equal(2)
        expect(position.lotCount).to.equal(2)

        const [longLot] = lots.filter(lot => lot.accountingType === AccountingType.Long)
        const [shortLot] = lots.filter(lot => lot.accountingType === AccountingType.Short)

        // assert debt values and short lot size
        expect(fillItem.debtDelta).to.equal(BigInt(498.75e6))
        expect(shortLot.size).to.equal(-fillItem.debtDelta) // short 498.75 USDC ==> size is negative
        expect(position.netDebt).to.equal(fillItem.netDebtAfter)
        const grossDebtDelta = fillItem.grossDebtAfter - fillItem.grossDebtBefore
        expect(grossDebtDelta).to.equal(fillItem.debtDelta)

        // assert collateral values and long lot size
        expect(fillItem.collateralDelta).to.equal(BigInt(598.508620e6))
        expect(longLot.size).to.equal(fillItem.collateralDelta) // long 598.508620 USDT ==> size is positive
        expect(position.netCollateral).to.equal(fillItem.collateralDelta)
        const grossCollateralDelta = fillItem.grossCollateralAfter - fillItem.grossCollateralBefore
        expect(grossCollateralDelta).to.equal(fillItem.collateralDelta)

        // assert cost
        expect(position.longCost).to.equal(BigInt(-598.5e6))
        expect(position.longCost).to.equal(longLot.openCost)
        expect(position.longCost).to.equal(fillItem.fillCost_long)

        expect(position.shortCost).to.equal(BigInt(498.757123e6))
        expect(position.shortCost).to.equal(shortLot.openCost)
        expect(shortLot.openCost).to.equal(fillItem.fillCost_short)

        // assert cashflows
        expect(fillItem.cashflow).to.equal(BigInt(100e6)) // USDC
        expect(fillItem.cashflowQuote).to.equal(BigInt(99.75e6)) // USDC (these values are without fees. they're only used for accounting purposes)
        expect(fillItem.cashflowBase).to.equal(99751497n) // 99.751497 USDT

        // assert reference prices (these are the prices used for valuing cashflows from one ccy to another and hence critical for accounting)
        expect(fillItem.referencePriceSource).to.equal(ReferencePriceSource.SwapPrice)
        expect(toThreeDecimals(mulDiv(fillItem.referencePrice_short, fillItem.cashflowQuote, BigInt(1e6)))).to.equal(toThreeDecimals(fillItem.cashflowBase))
        expect(toThreeDecimals(mulDiv(fillItem.referencePrice_long, fillItem.cashflowBase, BigInt(1e6)))).to.equal(toThreeDecimals(fillItem.cashflowQuote))
        
        expect(longLot.openCost).to.equal(-fillItem.debtDelta + -fillItem.cashflowQuote) // 498.75 + 99.75 = 598.50
        expect(shortLot.openCost).to.equal(fillItem.collateralDelta - fillItem.cashflowBase) // 598.508620 - 99.751497 = 498.757123

        // because it's the first fill, the gross values should equal the net values
        expect(longLot.grossOpenCost).to.equal(longLot.openCost)
        expect(longLot.grossSize).to.equal(longLot.size)
        expect(shortLot.grossOpenCost).to.equal(shortLot.openCost)
        expect(shortLot.grossSize).to.equal(shortLot.size)
      } else if (i === 1) {
        // this fill is a partial close
        expect(lots.length).to.equal(2)
        expect(position.lotCount).to.equal(2)
        const previousFillItem = fillItems[i - 1]

        const [longLot] = lots.filter(lot => lot.accountingType === AccountingType.Long)
        const [shortLot] = lots.filter(lot => lot.accountingType === AccountingType.Short)

        // assert debt values and short lot size
        expect(fillItem.debtDelta).to.equal(BigInt(-231.925250e6))
        const expectedShortLotSize = -previousFillItem.debtDelta - fillItem.debtCostToSettle - fillItem.debtDelta
        expect(shortLot.size).to.equal(expectedShortLotSize) // short 498.75 USDC ==> size is negative
        expect(position.netDebt).to.equal(fillItem.netDebtAfter)
        expect(fillItem.debtCostToSettle).to.equal(1015n) // 0.001015 USDC in interest accumulated since opening the position

        // assert collateral values and long lot size
        expect(fillItem.collateralDelta).to.equal(BigInt(-202.013204e6))
        const expectedLongLotSize = previousFillItem.collateralDelta + fillItem.lendingProfitToSettle + fillItem.collateralDelta
        expect(longLot.size).to.equal(expectedLongLotSize)
        expect(position.netCollateral).to.equal(fillItem.netCollateralAfter)
        expect(fillItem.lendingProfitToSettle).to.equal(4266n) // 0.004266 USDT in lending profit accumulated since opening the position

        // assert cost
        expect(fillItem.fillCost_long).to.equal(BigInt(202.041156e6)) // debtDelta + cashflowQuote
        expect(fillItem.fillCost_short).to.equal(BigInt(-231.893174e6)) // debtDelta in base ccy terms (aka collateralDelta - cashflowBase)
        expect(position.longCost).to.equal(BigInt(-396.491818e6))
        expect(position.shortCost).to.equal(BigInt(266.831315e6))
        expect(position.longCost).to.equal(longLot.openCost)
        expect(position.shortCost).to.equal(shortLot.openCost)

        // previous size was roughly 600, now we're closing roughly 200 (1/3rd)
        // previous open cost long was roughly 598.5, we should be closing 1/3rd of that so ca. 200
        const openCostRightBeforeTrade = previousFillItem.fillCost_long - fillItem.debtCostToSettle
        expect(openCostRightBeforeTrade).to.equal(BigInt(-598.501015e6)) // previous open cost + accrued debt cost

        const sizeRightBeforeTrade = previousFillItem.collateralDelta + fillItem.lendingProfitToSettle
        expect(sizeRightBeforeTrade).to.equal(BigInt(598.512886e6))

        const closedCostLong = mulDiv(openCostRightBeforeTrade, fillItem.collateralDelta, sizeRightBeforeTrade)
        expect(closedCostLong).to.equal(BigInt(202.009197e6)) // makes sense

        const expectedPnl_long = fillItem.fillCost_long - closedCostLong
        expect(fillItem.realisedPnl_long).to.equal(expectedPnl_long)
        expect(fillItem.realisedPnl_long).to.equal(31959n) // 0.031959 USDC

        // do the same but for the short lot
        const shortOpenCostRightBeforeTrade = previousFillItem.fillCost_short + fillItem.lendingProfitToSettle
        expect(shortOpenCostRightBeforeTrade).to.equal(BigInt(498.761389e6)) // previous short open cost + accrued debt cost

        const shortSizeRightBeforeTrade = -previousFillItem.debtDelta - fillItem.debtCostToSettle
        expect(shortSizeRightBeforeTrade).to.equal(BigInt(-498.751015e6)) // previous short size (-498.75) - accured debt (0.001015)

        const closedCostShort = mulDiv(shortOpenCostRightBeforeTrade, fillItem.debtDelta, shortSizeRightBeforeTrade)
        expect(closedCostShort).to.equal(BigInt(231.930074e6)) // makes sense

        const expectedPnl_short = fillItem.fillCost_short + closedCostShort
        expect(fillItem.realisedPnl_short).to.equal(expectedPnl_short)
        expect(fillItem.realisedPnl_short).to.equal(36900n) // 0.036900 USDT

        // assert cashflows
        expect(fillItem.cashflow).to.equal(BigInt(30e6)) // USDC
        expect(fillItem.cashflowQuote).to.equal(fillItem.cashflow - fillItem.fee) // USDC (these values are without fees. they're only used for accounting purposes)
        expect(fillItem.cashflowBase).to.equal(BigInt(29.879970e6)) // 29.879970 USDT

        // assert reference prices (these are the prices used for valuing cashflows from one ccy to another and hence critical for accounting)
        expect(fillItem.referencePriceSource).to.equal(ReferencePriceSource.SwapPrice)
        expect(toThreeDecimals(mulDiv(fillItem.referencePrice_short, fillItem.cashflowQuote, BigInt(1e6)))).to.equal(toThreeDecimals(fillItem.cashflowBase))
        expect(toThreeDecimals(mulDiv(fillItem.referencePrice_long, fillItem.cashflowBase, BigInt(1e6)))).to.equal(toThreeDecimals(fillItem.cashflowQuote))
      } else if (i === 2) {
        // this fill is a full close
        expect(lots.length).to.equal(0)
        expect(position.lotCount).to.equal(0)
        const previousFillItem = fillItems[i - 1]
        // assert debt values and short lot size
        expect(fillItem.debtDelta).to.equal(BigInt(-266.996703e6))
        expect(fillItem.netDebtBefore).to.equal(absolute(fillItem.debtDelta))
        expect(position.netDebt).to.equal(0n)
        expect(position.grossDebt).to.equal(0n)

        // assert collateral values and long lot size
        expect(fillItem.collateralDelta).to.equal(BigInt(-396.727943e6))
        expect(fillItem.netCollateralBefore).to.equal(absolute(fillItem.collateralDelta))
        expect(position.netCollateral).to.equal(0n)
        expect(position.grossCollateral).to.equal(0n)

        // assert cost
        expect(fillItem.fillCost_long).to.equal(BigInt(396.432347e6)) // debtDelta + cashflowQuote
        expect(fillItem.fillCost_short).to.equal(BigInt(-267.195799e6)) // debtDelta in base ccy terms (aka collateralDelta - cashflowBase)

        const openCostRightBeforeTrade = BigInt(-396.491818e6) - fillItem.debtCostToSettle // number comes from assertion in previous fill
        expect(openCostRightBeforeTrade).to.equal(BigInt(-396.662756e6)) // previous open cost + accrued debt cost

        const sizeRightBeforeTrade = fillItems.slice(0, i).reduce((acc, curr) => acc + (curr.collateralDelta + curr.lendingProfitToSettle), 0n) + fillItem.lendingProfitToSettle
        expect(sizeRightBeforeTrade).to.equal(BigInt(396.727943e6))

        const closedCostLong = mulDiv(openCostRightBeforeTrade, fillItem.collateralDelta, sizeRightBeforeTrade)
        expect(closedCostLong).to.equal(BigInt(396.662756e6))
        expect(closedCostLong).to.equal(-openCostRightBeforeTrade) // closed cost should be exactly the opposite to the open cost right before the trade

        const expectedPnl_long = fillItem.fillCost_long - closedCostLong
        expect(fillItem.realisedPnl_long).to.equal(expectedPnl_long)
        expect(fillItem.realisedPnl_long).to.equal(BigInt(-0.230409e6)) // previous fill pnl was: 0.031959 -> total: 0.031959 - 0.230409 = -0.198450
        expect(position.realisedPnl_long).to.equal(BigInt(-0.198450e6))

        // do the same but for the short lot
        const shortOpenCostRightBeforeTrade = BigInt(266.831315e6) + fillItem.lendingProfitToSettle
        expect(shortOpenCostRightBeforeTrade).to.equal(BigInt(267.059576e6)) // previous short open cost + accrued debt cost

        const shortSizeRightBeforeTrade = -fillItems.slice(0, i).reduce((acc, curr) => acc + (curr.debtDelta + curr.debtCostToSettle), 0n) - fillItem.debtCostToSettle
        expect(shortSizeRightBeforeTrade).to.equal(BigInt(-266.996703e6))

        const closedCostShort = mulDiv(shortOpenCostRightBeforeTrade, fillItem.debtDelta, shortSizeRightBeforeTrade)
        expect(closedCostShort).to.equal(BigInt(267.059576e6))

        const expectedPnl_short = fillItem.fillCost_short + closedCostShort
        expect(fillItem.realisedPnl_short).to.equal(expectedPnl_short)
        expect(fillItem.realisedPnl_short).to.equal(BigInt(-0.136223e6)) // previous fill short pnl was: 0.0369 -> total: 0.0369 - 0.136223 = -0.099323
        expect(position.realisedPnl_short).to.equal(BigInt(-0.099323e6))

        // assert cashflows
        expect(fillItem.cashflow).to.equal(BigInt(-129.302146e6)) // USDC
        expect(fillItem.cashflowQuote).to.equal(fillItem.cashflow - fillItem.fee) // USDC (these values are without fees. they're only used for accounting purposes)
        expect(fillItem.cashflowBase).to.equal(BigInt(-129.532144e6)) // 29.879970 USDT

        // assert reference prices (these are the prices used for valuing cashflows from one ccy to another and hence critical for accounting)
        expect(fillItem.referencePriceSource).to.equal(ReferencePriceSource.SwapPrice)
        expect(toThreeDecimals(mulDiv(fillItem.referencePrice_short, fillItem.cashflowQuote, BigInt(1e6)))).to.equal(toThreeDecimals(fillItem.cashflowBase))
        expect(toThreeDecimals(mulDiv(fillItem.referencePrice_long, fillItem.cashflowBase, BigInt(1e6)))).to.equal(toThreeDecimals(fillItem.cashflowQuote))
      }
    }

    // simplified version of the above (redundant but good for documentation)
    const fillItems = mockDb.entities.FillItem.getAll()
    const position = mockDb.entities.Position.get(id)
    if (!position) throw new Error('Position not found in test!')

    // all user cashflows are in USDC. He first puts 100, then adds 30, then closes with -129.302146
    const totalCashflows = fillItems.reduce((acc, curr) => acc + curr.cashflow, 0n) // 100 + 30 + -129.302146 = 0.697854
    // user pays fees in USDC too. first 0.25, then 0.115906, then 0.133498 on closing
    const totalFees = fillItems.reduce((acc, curr) => acc + curr.fee, 0n) //  0.25 + 0.115906 + 0.133498 = 0.499404

    expect(position.realisedPnl_long).to.equal(-totalCashflows + totalFees)
    await highLevelInvariants(id, 'working')
  })

  describe('High level invariants', () => {
    // only positions that have been closed, and have not been liquidated at all should be tested here
    const highLevelInvariantTestCases = [
      createIdForPosition({ chainId: 1, contangoPositionId: '0x4141564555534443000000000000000001ffffffff0000000000000000000304' }),
      createIdForPosition({ chainId: 42161, contangoPositionId: '0x5745544855534443000000000000000001ffffffff00000000000000000057f8' }),
      createIdForPosition({ chainId: 10, contangoPositionId: '0x5745544855534443000000000000000001ffffffff0000000000000000000012' }),
      createIdForPosition({ chainId: 100, contangoPositionId: '0x7344414955534443000000000000000001ffffffff00000000000000000004b5' }), // position managed through a SAFE
    ]

    highLevelInvariantTestCases.forEach((id) => {
      it(`${id}`, async function() {
        this.timeout(30000)
        const transactionHashes = await getTransactionHashes(id)    
        for (let i = 0; i < transactionHashes.length; i++) {
          mockDb = await processTransaction(transactionHashes[i], mockDb)
        }
        await highLevelInvariants(id)
      })
    })
  })

  describe('Liquidations', () => {
    const testCases = [
      {
        chainId: arbitrum.id,
        positionId: '0x574554485553444300000000000000000effffffff000000000100000000171c',
        liquidationTxHashes: ['0xd2e9f1be384feca885a778fdabd252a5008a2f4a34af87dc52b305435cabf67e'],
        description: 'Comet liquidation'
      },
      {
        chainId: arbitrum.id,
        positionId: '0x5745544855534443000000000000000001ffffffff0000000000000000005541',
        liquidationTxHashes: ['0x7257788de7d17094d7f65cba97558daf1f2f4e7dae2bd1a401c901c55a1b5717'],
        description: 'Aave v3 liquidation'
      },
      {
        chainId: arbitrum.id,
        positionId: '0x54414e474f555344430000000000000010ffffffff0000000000000000005664',
        liquidationTxHashes: ['0x04a053418b3df6943d1ab8b9e4e38f0542a8fe20329da5862c289ed4eb3d73ae'],
        description: 'TANGO/USDC.e - SILO'
      }
      // Add more test cases here as needed
    ];

    testCases.forEach(({ chainId, positionId, liquidationTxHashes, description }) => {
      it(`${description}`, async function() {
        this.timeout(30000);
        const id = createIdForPosition({ chainId, contangoPositionId: positionId });
        let transactionHashes = await getTransactionHashes(id);
        transactionHashes.push(...liquidationTxHashes.map(txHash => ({ chainId, transactionHash: txHash as Hex }))); // liquidation tx hash

        transactionHashes = (await Promise.all(transactionHashes.map(async (txHash) => {
          const blockNumber = await clients[txHash.chainId].getTransaction({ hash: txHash.transactionHash }).then(tx => tx.blockNumber)
          return { txHash, blockNumber }
        }))).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber)).map(x => x.txHash)
        
        for (let i = 0; i < transactionHashes.length; i++) {
          mockDb = await processTransaction(transactionHashes[i], mockDb);
          const { fillItem, position } = await getAssertionValues(id)
          if (fillItem.fillItemType === FillItemType.Liquidated || fillItem.fillItemType === FillItemType.LiquidatedFully) {
            expect(fillItem.fillPrice_long).to.not.equal(0n)
            expect(fillItem.fillPrice_short).to.not.equal(0n)
          }
        }

        await highLevelInvariantsForLiquidation(id);
      });
    });
  });
})
