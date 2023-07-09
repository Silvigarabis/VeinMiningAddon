import { EventTypes, EntityBase,
YoniPlayer, YoniBlock, Minecraft, 
Block,
runTask,
Location, Vector3, system } from "yoni-mcscripts-lib";

import { ItemUseSimulator } from "./ItemUseSimulator.js";

class VeinMining {
    veinBlocks: VeinBlocks;
    constructor(player: YoniPlayer,
        option: VeinMiningOption){
        this.player = player,
        this.veinBlocks = option.veinBlocks;
        this.simulator = new ItemUseSimulator(player);
        this.simulator.tool = player.getItemInMainHand();
    }
    runVein(): VeinMiningProcess {
        let process = new VeinMiningProcess(this);
        process.ececutor.run();
        return process;
    }
    getTool(): Minecraft.ItemStack {
    }
    setToolBroken(isBroken: boolean): void {
    }
    giveBackTool(item: Minecraft.ItemStack | undefined): void {
    }
    destroyBlocks(blocks: YoniBlock[]){
        if (!this.isToolAvailable()){
            throw new VeinMiningCantPerformAnymoreError(VeinMiningStatus.toolBroken);
        }
        
        this.simulator.tool = this.getTool();
        
        this.simulator.destroyBlocks(blocks);
        this.giveBackTool(this.simulator.tool);
        this.addAffections(this.simulator.affections);
        
        if (!this.simulator.isToolAvailable()){
            this.setToolBroken(true);
            throw new VeinMiningCantPerformAnymoreError(VeinMiningStatus.toolBroken);
        }
    }
    addAffections(affections: SimulateAffection[]){
        this.parsedVeinBlockCount += affections.length
        affections.forEach(aff => aff.performOn(this.player));
    }
    parsedVeinBlockCount: number = 0;
    simulator: ItemUseSimulator;
    receiveError(err: any){
        if (err instanceof VeinMiningCantPerformAnymoreError){
            this.emitVeinMiningInterruptedEvent(err.reason);
        }
    }
}

class VeinMiningError extends Error {
}

interface VeinMiningProcessOnCompleteFunction {
    (player: YoniPlayer, miningData: VeinMining): void;
}

class VeinMiningProcess {
    constructor(miningData: VeinMining){
        this.executor = new VeinMiningExecutor(miningData);
        this.miningData = miningData;
    }
    readonly miningData: VeinMining;
    readonly executor: VeinMiningExecutor;
}

interface VeinMiningOption {
    overrideBlockType?: Minecraft.BlockType | string;
    selectedBlockTypes?: Minecraft.BlockType[];
    veinBlocks: VeinBlocks;
    destroyBlock: VeinMiningDestroyFunction;
}

interface VeinMiningDestroyFunction {
    (location: Location, destroyOption: VeinMiningDestroyOption): VeinMiningDestroyResult;
}

interface VeinMiningDestroyResult {
    success: boolean;
    giveBackItems?: Minecraft.ItemStack[];
    usedTool?: Minecraft.ItemStack[];
}

class VeinMiningExecutorTimer {
    constructor(perTickMaxTime: number){
        this.perTickMaxTime = perTickMaxTime;
    }
    perTickMaxTime: number;
    static getCurrentTick(): number {
        return system.currentTick;
    }
    #handleTick: number = -1;
    #lastQueryTime: number = Date.now();
    #passedTime: number = 0;
    #isHandled = false;
    handle(){
        if (this.#isHandled)
            this.unhandle();
        if (VeinMiningExecutorTimer.getCurrentTick() !== this.#handleTick){
            this.#handleTick = VeinMiningExecutorTimer.getCurrentTick();
            this.#passedTime = 0;
        }
        this.#isHandled = true;
        this.#lastQueryTime = Date.now();
    }
    unhandle(){
        if (this.#isHandled)
            this.#passedTime += Date.now() - this.#lastQueryTime;
        this.#isHandled = false;
    }
    isTimeLimitExceed(): boolean {
        this.#passedTime += Date.now() - this.#lastQueryTime;
        this.#lastQueryTime = Date.now();
        return this.#passedTime > this.perTickMaxTime;
    }
}

class VeinMiningExecutor {
    constructor(miningData: VeinMining){
        this.miningData = miningData;
    }
    
    readonly miningData: VeinMining;
    
    static timer = new VeinMiningExecutorTimer(6); // only execute 6ms per tick
    async run(){
        try {
        
            while (this.miningData.veinBlocks.hasMore()){
                this.continueNext();
            
                //降低连锁数量以减少tps降低
                if (this.autoModifyMaxCountPerTick)
                    this.maxCountPerTick = Math.max(this.minCountPerTick, this.maxCountPerTick - 20);
                
                // wait for next ticking
                let { promise, resolve } = VeinMiningExecutor.generatePendingPromise();
                runTask(() => resolve());
                await promise;
            }
            
        } catch (err){
        
            VeinMiningExecutor.timer.unhandle();
            this.miningData.receiveError(err);
        }
        
    }
    continueNext(){
        VeinMiningExecutor.timer.handle();
        
        while (this.miningData.veinBlocks.hasMore()){
            this.destroyVeinBlocks();
            
            //超时，结束
            if (VeinMiningExecutor.timer.isTimeLimitExceed())
                break;
            
            //增加连锁数量以提高效率
            if (this.autoModifyMaxCountPerTick)
                this.maxCountPerTick += 20;
            
        }
        
        VeinMiningExecutor.timer.unhandle();
    }
    
    autoModifyMaxCountPerTick = true;
    
    maxCountPerTick = 200;
    
    minCountPerTick = 20;
    
    destroyVeinBlocks(){
        let blocks = this.miningData.veinBlocks.next(this.maxCountPerTick);
        this.miningData.destroyBlocks(blocks);
    }
        
    static generatePendingPromise(): { promise: Promise<void>, reject: Function, resolve: Function } {
        let resolve: Function, reject: Function;
        let promise: Promise<void> = new Promise((re, rj) => {
            resolve = re;
            reject = rj;
        });
        //@ts-ignore 这是基于Promise对象会在创建时就运行传入的函数而实现的
        return { promise, reject, resolve };
    }
}

interface VeinMiningDestroyOption {
    tool?: Minecraft.ItemStack;
    player?: YoniPlayer;
}


interface VeinBlocks {
    next(count: number): YoniBlock[];
    hasMore(): boolean;
}

class CenterAroundVeinBlocks implements VeinBlocks {
    constructor(blockTypes: Minecraft.BlockType[], center: Location){
        this.detectingBlocks.push(center.getBlock());
        this.blockTypes = blockTypes;
    }
    blockTypes: Minecraft.BlockType[];
    next(count: number = 10): YoniBlock[] {
        const { detectingBlocks } = this;
        const blocks: YoniBlock[] = [];
        while (blocks.length < count && detectingBlocks.length > 0){
             let oneDetectingBlock = detectingBlocks.shift() as YoniBlock;
             let aroundBlocks = CenterAroundVeinBlocks.getAroundBlocks(oneDetectingBlock);
             let undetectBlocks = aroundBlocks.filter(v=>!this.has(v));
             let targetBlocks = undetectBlocks.filter(this.matchBlock);
             blocks.push(...targetBlocks);
             detectingBlocks.push(...targetBlocks);
             undetectBlocks.forEach(this.add.bind(this));
        }
        return blocks;
    }
    matchBlock(block: YoniBlock): boolean {
        return this.blockTypes.includes(block.type);
    }
    hasMore(): boolean {
        return this.detectingBlocks.length > 0;
    }
    blocksRecord: Record<number, Record<number, number[]>> = {};
    add(block: YoniBlock){
        const { blocksRecord } = this;
        
        const { x, y, z } = block;
        
        if (!(x in blocksRecord))
            blocksRecord[x] = {};
        
        if (!(y in blocksRecord[x]))
            blocksRecord[x][y] = [];
        
        blocksRecord[x][y].push(z);
    }
    has(block: YoniBlock): boolean {
        const { blocksRecord } = this;
        
        const { x, y, z } = block;
        return x in blocksRecord
            && y in blocksRecord[x]
            && blocksRecord[x][y].includes(z);
    }
    static getAroundBlocks(block: YoniBlock): YoniBlock[] {
        return [
        block.location.offset(-1,0,0).getBlock(),
        block.location.offset(1,0,0).getBlock(),
        block.location.offset(0,-1,0).getBlock(),
        block.location.offset(0,1,0).getBlock(),
        block.location.offset(0,0,-1).getBlock(),
        block.location.offset(0,0,1).getBlock()
        ];
    }
    blocks: YoniBlock[] = [];
    detectingBlocks: YoniBlock[] = [];
}