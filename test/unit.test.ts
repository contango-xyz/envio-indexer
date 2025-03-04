import { expect } from 'chai'
import { Position, SpotExecutor_SwapExecuted_event, TestHelpers } from 'generated'
import { describe, it } from 'mocha'
import { ReferencePriceSource } from '../src/accounting/helpers'
import { AccountingType } from '../src/accounting/lotsAccounting'
import { createTokenId } from '../src/utils/getTokenDetails'
import { createIdForPosition, IdForPosition } from '../src/utils/ids'
import { ContangoEvents, FillItemType, ReturnPromiseType, SwapEvent } from '../src/utils/types'
import { getTransactionEvents, getTransactionHashes, processTransaction, processTransactions } from './testHelpers'
import { decodeFeeEvent } from '../src/StrategyProxy'
import { Hex, toHex } from 'viem'
import { createInstrumentId, getBalancesAtBlock } from '../src/utils/common'
import { mulDiv } from '../src/utils/math-helpers'
import { clients } from '../src/clients'
import { arbitrum, mainnet } from 'viem/chains'
const { MockDb } = TestHelpers

const getFeeEventMaybe = (events: ReturnPromiseType<typeof getTransactionEvents>) => {
  const feeEventMaybe = events.find(event => event?.eventName === 'StragegyExecuted')
  if (feeEventMaybe && toHex("FeeCollected", { size: 32 }) === (feeEventMaybe.args as any).action) {
    return decodeFeeEvent((feeEventMaybe.args as any).data as Hex)
  }
  return null
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

  async function highLevelInvariants(id: IdForPosition) {
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
  }

  async function highLevelInvariantsForLiquidation(id: IdForPosition) {
    const position = mockDb.entities.Position.get(id)
    if (!position) throw new Error('Position not found in test!')
    const fillItems = mockDb.entities.FillItem.getAll()
    const { debtToken, collateralToken } = await getTokensForPosition(position)

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

      if (fillItem.fillItemType === FillItemType.ClosedByLiquidation || fillItem.fillItemType === FillItemType.Liquidated) {
        liquidationPenaltyBase += mulDiv(fillItem.realisedPnl_short, fillItem.liquidationPenalty, BigInt(1e4))
        liquidationPenaltyQuote += mulDiv(fillItem.realisedPnl_long, fillItem.liquidationPenalty, BigInt(1e4))
      }
    }

    const fillItemTypes = fillItems.map(fillItem => fillItem.fillItemType)

    // expect(liquidationPenaltyBase).to.not.equal(0n)
    // expect(liquidationPenaltyQuote).to.not.equal(0n)
    
    expect((Number(position.realisedPnl_long) / Number(debtToken.unit)).toFixed(3)).to.equal((Number(position.cashflowQuote) / Number(debtToken.unit) * -1).toFixed(3))
    expect((Number(position.realisedPnl_short) / Number(collateralToken.unit)).toFixed(3)).to.equal((Number(position.cashflowBase) / Number(collateralToken.unit) * -1).toFixed(3))
  }

  it('RDNT/ETH short - Chain: Arbitrum - Number: #20498', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, positionId: '0x5745544852444e54000000000000000010ffffffff0000000000000000005012' })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(id, transactionHashes[i], mockDb)

      const position = mockDb.entities.Position.get(id)
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const lots = mockDb.entities.Lot.getAll()
      const fillItem = fillItems[i]

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
    const id = createIdForPosition({ chainId: 42161, positionId: '0x4152424441490000000000000000000001ffffffff0200000000000000005318' })
    mockDb = await processTransactions(id, mockDb)

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
  ]

  simpleMigrationTestCases.forEach(({ chainId, oldPositionId, newPositionId, description }) => {
    it(`Migration test: ${description}`, async function() {
      this.timeout(30000)
      const id = createIdForPosition({ chainId, positionId: oldPositionId })
      const transactionHashes = await getTransactionHashes(id)
      const positionSnapshots: Position[] = []
      let lotsCountBefore = 0
      let newPositionFound = false

      for (let i = 0; i < transactionHashes.length; i++) {
        mockDb = await processTransaction(id, transactionHashes[i], mockDb)
        const oldPosition = mockDb.entities.Position.get(id)
        if (!oldPosition) throw new Error('Position not found in test!')
        
        const migratedToId = createIdForPosition({ chainId, positionId: newPositionId })
        const newPosition = mockDb.entities.Position.get(migratedToId)

        if (newPosition) {
          newPositionFound = true
          const lots = mockDb.entities.Lot.getAll()
          const lotsCountAfterMigration = lots.length
          const eventsInMigrationTransaction = await getTransactionEvents(id, transactionHashes[i])
          const fillItems = mockDb.entities.FillItem.getAll()
          const positionBeforeMigration = positionSnapshots[positionSnapshots.length - 1]
          const [migrationOpenFillItem, migrationCloseFillItem] = fillItems.reverse()

          // ensure that the number of lots is the same before and after migration
          expect(lotsCountAfterMigration).to.equal(lotsCountBefore)
          for (const lot of lots) {
            expect(lot.id).to.contain(newPositionId)
          }

          // first assert that the old position has been reset to zero
          expect(oldPosition.accruedDebtCost).to.equal(0n)
          expect(oldPosition.accruedLendingProfit).to.equal(0n)
          expect(oldPosition.cashflowBase).to.equal(0n)
          expect(oldPosition.cashflowQuote).to.equal(0n)
          expect(oldPosition.realisedPnl_long).to.equal(0n)
          expect(oldPosition.realisedPnl_short).to.equal(0n)
          expect(oldPosition.longCost).to.equal(0n)
          expect(oldPosition.shortCost).to.equal(0n)
          expect(oldPosition.lotCount).to.equal(0)
          expect(oldPosition.collateral).to.equal(0n)
          expect(oldPosition.debt).to.equal(0n)
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
          expect(oldPosition.instrument_id).to.equal(newPosition.instrument_id)

          // check that the fillItemTypes are set correctly
          expect(migrationOpenFillItem.fillItemType).to.equal(FillItemType.MigrationOpen)
          expect(migrationCloseFillItem.fillItemType).to.equal(FillItemType.MigrationClose)

          // check that the new position has the same collateral and debt as the old position PLUS the interest accrued has been settled
          expect(newPosition.collateral).to.equal(positionBeforeMigration.collateral + migrationCloseFillItem.lendingProfitToSettle)
          expect(newPosition.debt).to.equal(positionBeforeMigration.debt + migrationCloseFillItem.debtCostToSettle)
          expect(newPosition.accruedLendingProfit).to.equal(positionBeforeMigration.accruedLendingProfit + migrationCloseFillItem.lendingProfitToSettle)
          expect(newPosition.accruedDebtCost).to.equal(positionBeforeMigration.accruedDebtCost + migrationCloseFillItem.debtCostToSettle)

          // we currently don't have any migrations that have cashflows, but if we ever do, we need to decide where to assign those cashflows (in terms of fill items)
          // if we make the right hand side of the assertion this way, then we'll be alerted to the fact that we need to update the code
          expect(newPosition.cashflowBase).to.equal(positionBeforeMigration.cashflowBase + migrationCloseFillItem.cashflowBase + migrationOpenFillItem.cashflowBase)
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
      const id = createIdForPosition({ chainId, positionId: oldPositionId })
      const transactionHashes = await getTransactionHashes(id)
      const positionSnapshots: Position[] = []
      let newPositionFound = false

      for (let i = 0; i < transactionHashes.length; i++) {
        mockDb = await processTransaction(id, transactionHashes[i], mockDb)
        const oldPosition = mockDb.entities.Position.get(id)
        if (!oldPosition) throw new Error('Position not found in test!')
        
        const migratedToId = createIdForPosition({ chainId, positionId: newPositionId })
        const newPosition = mockDb.entities.Position.get(migratedToId)

        if (newPosition) {
          newPositionFound = true
          const eventsInMigrationTransaction = await getTransactionEvents(id, transactionHashes[i])
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
          expect(oldPosition.accruedDebtCost).to.equal(0n)
          expect(oldPosition.accruedLendingProfit).to.equal(0n)
          expect(oldPosition.cashflowBase).to.equal(0n)
          expect(oldPosition.cashflowQuote).to.equal(0n)
          expect(oldPosition.realisedPnl_long).to.equal(0n)
          expect(oldPosition.realisedPnl_short).to.equal(0n)
          expect(oldPosition.longCost).to.equal(0n)
          expect(oldPosition.shortCost).to.equal(0n)
          expect(oldPosition.lotCount).to.equal(0)
          expect(oldPosition.collateral).to.equal(0n)
          expect(oldPosition.debt).to.equal(0n)
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
          expect(migrationOpenFillItem.fillItemType).to.equal(FillItemType.MigrationOpen)
          expect(migrationCloseFillItem.fillItemType).to.equal(FillItemType.MigrationClose)

          const swapEvent = getSwapEventMaybe(eventsInMigrationTransaction)

          expect(swapEvent).to.not.be.null
          if (!swapEvent) throw new Error('Swap event not found in test!')

          expect(Number(migrationCloseFillItem.lendingProfitToSettle)).to.be.greaterThanOrEqual(Number(swapEvent.params.amountIn - positionBeforeMigration.collateral))
          expect(newPosition.collateral).to.equal(swapEvent.params.amountOut)
          expect(newPosition.debt).to.equal(migrationOpenFillItem.debtDelta)

          // we're migrating the base ccy
          expect(newPosition.accruedLendingProfit).to.equal(0n)
          expect(newPosition.accruedDebtCost).to.equal(0n)

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

  it('Some random migration', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, positionId: '0x777374455448574554480000000000001fffffffff0000000005000000004b63' })
    mockDb = await processTransactions(id, mockDb)

    const oldPosition = mockDb.entities.Position.get(id)
    if (!oldPosition) throw new Error('Position not found in test!')

    expect(oldPosition.migratedTo_id).to.equal('42161_0x777374455448574554480000000000000effffffff00000000030000000053f9')
    expect(oldPosition.cashflowBase).to.equal(0n)
    expect(oldPosition.cashflowQuote).to.equal(0n)
    expect(oldPosition.realisedPnl_long).to.equal(0n)
    expect(oldPosition.realisedPnl_short).to.equal(0n)
    expect(oldPosition.longCost).to.equal(0n)
    expect(oldPosition.shortCost).to.equal(0n)
    expect(oldPosition.collateral).to.equal(0n)
    expect(oldPosition.debt).to.equal(0n)
    expect(oldPosition.accruedLendingProfit).to.equal(0n)
    expect(oldPosition.accruedDebtCost).to.equal(0n)
    expect(oldPosition.fees_long).to.equal(0n)
    expect(oldPosition.fees_short).to.equal(0n)
    
    const newPosition = mockDb.entities.Position.get(oldPosition.migratedTo_id!)
    if (!newPosition) throw new Error('New position not found in test!')

    expect(newPosition.migratedTo_id).to.equal(undefined)
    expect(Number(newPosition.collateral)).to.be.greaterThan(0)
  })

  it('Position managed through a SAFE', async function() {
    this.timeout(30000)
    const positionId = '0x7344414955534443000000000000000001ffffffff00000000000000000004b5'
    const id = createIdForPosition({ chainId: 100, positionId })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(id, transactionHashes[i], mockDb)
    }

    await highLevelInvariants(id)
  })

  it('Short ETH/USDC - 0x leverage', async function() {
    this.timeout(30000)
    const positionId = '0x5553444357455448000000000000000001ffffffff000000000000000000005c'
    const id = createIdForPosition({ chainId: 42161, positionId })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(id, transactionHashes[i], mockDb)
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
        expect(position.realisedPnl_short).to.equal(155n)
        expect(fillItem.realisedPnl_short).to.equal(155n)
        expect(fillItem.fillCost_short).to.equal(155n) // precision error
        expect(fillItem.fillPrice_short).to.equal(191549n)
        expect(fillItem.fillItemType).to.equal(FillItemType.Closed)
      }
    }
  })

  it('ARB/DAI Lodestar - position with multiple liquidations', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, positionId: '0x5745544857584441490000000000000007ffffffff0000000000000000000001' })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(id, transactionHashes[i], mockDb)
      const position = mockDb.entities.Position.get(id)
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const fillItem = fillItems[i]
    }
  })

  it('ARB/USDC long - Chain: Arbitrum - Number: #5488', async function() {
    this.timeout(30000)
    const id = createIdForPosition({ chainId: 42161, positionId: '0x415242555344432e6e0000000000000001ffffffff0200000000000000001570' })
    const transactionHashes = await getTransactionHashes(id)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(id, transactionHashes[i], mockDb)

      const position = mockDb.entities.Position.get(id)
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const fillItem = fillItems[i]

      if (i === 0) {
        expect(fillItem.cashflow).to.equal(BigInt(0.02e18))
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

        expect(fillItem.referencePrice_short).to.equal(1184862200526078817n) // 1 / 0.842603 = 1.18486 (the inverse of the long trade price)
        expect(fillItem.fillPrice_short).to.equal(1184861653848222336n) // 1 / 0.842603 = 1.18486 (the inverse of the long trade price)

        expect(fillItem.realisedPnl_long).to.equal(222214n) // sum of quote cashflows
        expect(fillItem.realisedPnl_short).to.equal(80867067518738762881n - 80735499391093514082n) // sum of base cashflows
      }
    }

    await highLevelInvariants(id)
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
      // {
      //   chainId: mainnet.id,
      //   positionId: '0x7245544844414900000000000000000007ffffffff000000000000000000000f',
      //   liquidationTxHashes: ['0xe0413af6eae2e644f7ce3fd671e8d159d1c23c3beb6d7f9cb5ec0e00aa596a83'],
      //   description: 'Spark liquidation'
      // }
      // Add more test cases here as needed
    ];

    testCases.forEach(({ chainId, positionId, liquidationTxHashes, description }) => {
      it(`${description}`, async function() {
        this.timeout(30000);
        const id = createIdForPosition({ chainId, positionId });
        let transactionHashes = await getTransactionHashes(id);
        transactionHashes.push(...liquidationTxHashes.map(txHash => txHash as Hex)); // liquidation tx hash

        transactionHashes = (await Promise.all(transactionHashes.map(async (txHash) => {
          const blockNumber = await clients[chainId].getTransaction({ hash: txHash }).then(tx => tx.blockNumber)
          return { txHash, blockNumber }
        }))).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber)).map(x => x.txHash)
        
        for (let i = 0; i < transactionHashes.length; i++) {
          mockDb = await processTransaction(id, transactionHashes[i], mockDb);

          const fillItems = mockDb.entities.FillItem.getAll()
          const position = mockDb.entities.Position.get(id)
          if (!position) throw new Error('Position not found in test!')
          const fillItem = fillItems[i]

          // const balancesBefore = await getBalancesAtBlock(chainId, positionId, fillItem.blockNumber - 1)
          // const balancesAfter = await getBalancesAtBlock(chainId, positionId, fillItem.blockNumber)

          // console.log({
          //   fillItem: Number(fillItem.debtDelta) / 1e6,
          //   actual: Number(balancesAfter.debt - balancesBefore.debt) / 1e6,
          //   position: Number(position.debt) / 1e6,
          //   accruedDebtCost: Number(position.accruedDebtCost) / 1e6,
          //   accruedLendingProfit: Number(position.accruedLendingProfit) / 1e6,
          //   typeof: typeof position.debt,
          //   cashflowQuote: Number(fillItem.cashflowQuote) / 1e6,
          //   positionCashflowQuote: Number(position.cashflowQuote) / 1e6,
          // })

          // console.log('fillItem', fillItem)
        }

        await highLevelInvariantsForLiquidation(id);
      });
    });
  });
})
