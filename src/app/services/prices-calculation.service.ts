import {Injectable} from '@angular/core';
import {HarvestDto} from '../models/harvest-dto';
import {VaultStats} from '../models/vault-stats';
import {LpStat} from '../models/lp-stat';
import {PricesDto} from '../models/prices-dto';
import {StaticValues} from '../static/static-values';
import {HardWorkDto} from '../models/hardwork-dto';
import {RewardDto} from '../models/reward-dto';
import {NGXLogger} from 'ngx-logger';
import {ContractsService} from './contracts.service';
import {Vault} from '../models/vault';
import {RewardsService} from './http/rewards.service';
import {HttpService} from "./http/http.service";
import {HarvestsService} from "./http/harvests.service";
import {PricesService} from "./http/prices.service";

@Injectable({
  providedIn: 'root'
})
export class PricesCalculationService {
  public tvls = new Map<string, number>();
  public tvlNames = new Set<string>();
  public allTvls = 0.0;
  public vaultStats = new Map<string, VaultStats>();
  public lastHarvests = new Map<string, HarvestDto>();
  public lastHardWorks = new Map<string, HardWorkDto>();
  public lastRewards = new Map<string, RewardDto>();
  public latestHarvest: HarvestDto;
  public latestHardWork: HardWorkDto;
  private lastTvlDates = new Map<string, number>();
  private rewardEnded = new Set<string>();
  private lastPrices = new Map<string, PricesDto>();

  constructor(private log: NGXLogger, private contractsService: ContractsService,
              private  pricesService: PricesService,
              private rewardsService: RewardsService,
              private httpService: HttpService,
              private harvestsService: HarvestsService) {
    contractsService.getContracts(Vault).subscribe(vaults => {
      vaults.forEach(v => this.tvls.set(v.contract.name, 0.0));
    });
    this.pricesService.getLastPrices().subscribe(data => data?.forEach(this.savePrice.bind(this)));
    this.harvestsService.getHarvestTxHistoryData().subscribe(data => data?.forEach(this.writeFromHarvestTx.bind(this)));
    this.rewardsService.getLastRewards().subscribe(data => data?.forEach(reward => this.saveReward(RewardDto.enrich(reward))));
    this.subscribeToPrices();
    this.subscribeToRewards();
  }

  public writeFromHarvestTx(tx: HarvestDto): void {
    if (!this.latestHarvest || this.latestHarvest.blockDate < tx.blockDate) {
      if (tx.lastGas != null
          && tx.network === 'eth'
          && (tx.lastGas + '') !== 'NaN'
          && tx.lastGas !== 0) {
        StaticValues.lastGas = tx.lastGas;
      }
      this.latestHarvest = tx;
    }
    if (!tx || this.lastTvlDates.get(tx.vault) > tx.blockDate) {
      return;
    }
    if (tx.vault === 'iPS') {
      StaticValues.stakedNewPS = (tx.lastTvl / tx.totalAmount) * 100;
    }
    const vaultStats = new VaultStats();
    vaultStats.lpStat = tx.lpStatDto;
    vaultStats.tvl = tx.lastTvl;
    vaultStats.owners = tx.ownerCount;
    this.vaultStats.set(tx.vault, vaultStats);
    this.lastTvlDates.set(tx.vault, tx.blockDate);
    this.lastHarvests.set(tx.vault, tx);
  }

  public saveHardWork(tx: HardWorkDto): void {
    if (!tx || this.lastHardWorks.get(tx.vault)?.blockDate > tx.blockDate) {
      this.log.warn('Old hard work', tx);
      return;
    }

    if (!this.latestHardWork || this.latestHardWork.blockDate < tx.blockDate) {
      this.latestHardWork = tx;
    }

    this.lastHardWorks.set(tx.vault, tx);
  }

  saveReward(tx: RewardDto): void {
    if (!tx || this.lastRewards.get(tx.vault)?.blockDate > tx.blockDate) {
      return;
    }
    this.lastRewards.set(tx.vault, tx);
  }

  // -------------------------- GETTERS ----------------------------------
  vaultReward(tvlName: string): number {
    const reward = this.lastRewards.get(tvlName);
    if (!reward || (Date.now() / 1000) > reward.periodFinish) {
      return 0;
    }
    return reward.reward;
  }

  vaultRewardPeriod(tvlName: string): number {
    const reward = this.lastRewards.get(tvlName);
    if (!reward || (Date.now() / 1000) > reward.periodFinish) {
      return 0;
    }
    return ((reward.periodFinish - reward.blockDate) / 60 / 60 / 24);
  }

  vaultRewardWeeklyApy(tvlName: string): number {
    const reward = this.lastRewards.get(tvlName);
    if (!reward || (Date.now() / 1000) > reward.periodFinish) {
      return 0;
    }
    return reward.weeklyApy;
  }

  vaultRewardApr(poolName: string): number {
    const reward = this.lastRewards.get(poolName);
    const harvest = this.lastHarvests.get(poolName);
    if (!harvest || !reward) {
      return 0;
    }
    if ((Date.now() / 1000) > reward.periodFinish && !StaticValues.isPS.has(poolName)) {
      if (!this.rewardEnded.has(poolName)) {
        this.log.warn(poolName + ' reward setup zero, it is ended');
        this.rewardEnded.add(poolName);
      }
      return 0;
    }
    const period = StaticValues.SECONDS_OF_YEAR / (reward.periodFinish - reward.blockDate);
    const rewardUsd = reward.reward * StaticValues.lastPrice;
    return (rewardUsd / harvest?.lastUsdTvl) * period * 100;
  }

  psIncome(): number {
    return (this.latestHardWork?.allProfit / 0.7) * 0.3;
  }

  incomeApr(tvlName: string): number {
    const hardWork = this.lastHardWorks.get(tvlName);
    if (hardWork) {
      if ((Date.now() / 1000) - hardWork.blockDate > (StaticValues.SECONDS_OF_DAY * 14)) {
        // this.log.warn('old hw for ' + tvlName);
        return 0;
      }
      let avgTvl = hardWork?.weeklyAverageTvl;
      if (!avgTvl || avgTvl === 0) {
        avgTvl = hardWork?.tvl;
      }
      const weeklyProfit = Math.max(hardWork.weeklyProfit, 0);
      return (StaticValues.SECONDS_OF_YEAR / StaticValues.SECONDS_OF_WEEK)
          * ((weeklyProfit / avgTvl) * 100.0);
    }
    return 0;
  }

  weeklyAllIncome(): number {
    return (this.latestHardWork?.weeklyAllProfit / 0.7);
  }

  lastFarmPrice(): number {
    if (StaticValues.lastPrice != null) {
      return StaticValues.lastPrice;
    }
    return 0.0;
  }

  savedGasFees(): number {
    let fees = 0;
    for (const hw of this.lastHardWorks.values()) {
      if (hw.network === 'eth' && hw.savedGasFeesSum) {
        fees += hw.savedGasFeesSum;
      } else {
        // this.log.warn('Saved Gas fees not found in ', hw);
      }
    }
    return fees;
  }

  farmLpStaked(): number {
    let farmInLp = 0;
    let lpStaked = 0;
    for (const name of StaticValues.farmPools) {
      const harvest = this.lastHarvests.get(name);
      if (!harvest) {
        continue;
      }
      if (harvest.lpStatDto?.coin1 === 'FARM') {
        farmInLp += harvest.lpStatDto.amount1;
      }
      if (harvest.lpStatDto?.coin2 === 'FARM') {
        farmInLp += harvest.lpStatDto.amount2;
      }
    }
    if (farmInLp !== 0) {
      lpStaked = (farmInLp / StaticValues.farmTotalSupply) * 100;
    }
    return lpStaked;
  }

  public getPrice(name: string): number {
    name = StaticValues.mapCoinNameToSimple(name);
    if (StaticValues.isStableCoin(name)) {
      return 1.0;
    }
    if (name === 'FARM') {
      return this.lastFarmPrice();
    }
    if (!this.lastPrices.has(name)) {
      return 0;
    }
    const usdPrice = this.getPrice(this.lastPrices.get(name).otherToken);
    return this.lastPrices.get(name).price * usdPrice;
  }

  private calculateTvlForLp(lpStat: LpStat): number {
    const simpleName1 = StaticValues.mapCoinNameToSimple(lpStat.coin1);
    const simpleName2 = StaticValues.mapCoinNameToSimple(lpStat.coin2);
    const price1 = this.getPrice(simpleName1);
    const price2 = this.getPrice(simpleName2);
    const amount1 = price1 * lpStat.amount1;
    const amount2 = price2 * lpStat.amount2;
    // this.log.debug('calculateTvlForLp ', simpleName1, simpleName2, price1, price2, amount1, amount2);
    return amount1 + amount2;
  }

  public savePrice(tx: PricesDto): void {
    const name = StaticValues.mapCoinNameToSimple(tx.token);
    const lastPriceDto = this.lastPrices.get(name);
    if (lastPriceDto) {
      if (lastPriceDto.source !== tx.source) {
        this.log.warn('got prices with different sources', lastPriceDto.source, tx.source);
        // return;
      }
      if (lastPriceDto.block > tx.block) {
        this.log.warn('Loaded old price!', tx);
        return;
      }
      const diff = (Math.abs(lastPriceDto.price - tx.price) / tx.price) * 100;
      if (diff > 5) {
        this.log.info('New price changed more than 5%', lastPriceDto, tx);
      }
    }
    this.lastPrices.set(name, tx);
  }

  private subscribeToPrices() {
    this.pricesService.subscribeToPrices().subscribe(prices => {
      this.savePrice(prices);
    });
  }

  private subscribeToRewards() {
    this.rewardsService.subscribeToRewards().subscribe(this.saveReward.bind(this));
  }
}
