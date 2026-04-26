/**
 * 抖音福袋核心流程
 * 1. 判断当前页面是否为抖音站点，不是则跳转到抖音首页。
 * 2. 判断当前是否为推荐页，不是则点击推荐入口或直接跳转到推荐页。
 * 3. 在推荐页等待页面稳定，然后按方向键向下刷内容。
 * 4. 判断当前内容是普通视频、普通直播还是福袋直播。
 * 5. 命中福袋直播后进入直播间，等待左上角福袋入口出现并点击。
 * 6. 福袋弹窗出现后，若已参与则关闭弹窗；若未参与则持续点击主按钮。
 * 7. 福袋流程结束后回到推荐页，继续交给主循环切到下一条内容。
 */

function installDouyinFudaiAutomation(options = {}) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    if (window.top !== window) {
        return null;
    }

    if (window.__douyinFudaiCoreApi) {
        return window.__douyinFudaiCoreApi;
    }

    const pageLogPrefix = '[douyin-fudai]';
    const recentLivePrefix = 'douyin_fudai_recent_live:';
    const automationOptions = createAutomationOptions(options);
    const entranceUrl = automationOptions.entranceUrl;
    const recommendUrl = automationOptions.recommendUrl;
    const config = {
        recentLiveTtlMs: 30000,
        recommendPageInitialWaitMs: 5000,
        contentStayMs: 3500,
        contentStableTimeoutMs: 8000,
        contentSwitchTimeoutMs: 4200,
        contentChangeStableMs: 400,
        contentReadyStableMs: 500,
        fudaiSignalWaitMs: 2200,
        fudaiSignalPollMs: 350,
        liveRoomEnterTimeoutMs: 5000,
        liveRoomStableWaitMs: 5000,
        pageStatePollMs: 300,
        recommendReturnTimeoutMs: 10000,
        recommendResumeWaitMs: 1500,
        nextContentKeyDelayMs: 120,
        luckyBagEntryTimeoutMs: 12000,
        luckyBagEntryPollMs: 300,
        luckyBagTotalTimeoutMs: 30000,
        luckyBagIdleFinishMs: 4000,
        luckyBagIdlePollMs: 500,
        luckyBagExitBufferMs: 2000,
        luckyBagPopupActionRetryMs: 1000,
        luckyBagPopupClickWaitMs: 3000,
        luckyBagEntryClickWaitMs: 1500
    };
    const state = {
        running: false,
        logBox: null,
        currentAccountName: '',
        currentDiamondBalance: 0,
        homeBalanceSyncDone: false,
        recommendSideSyncTimer: null,
        recommendSideSyncRunning: false
    };
    const feedItemSelector = '.page-recommend-container, [data-e2e="feed-item"]';
    const luckyBagSelectors = {
        entryImages: [
            'img[src*="lottery_new"]',
            'img[src*="lottery"]'
        ],
        entryFallback: [
            '.ShortTouchContainer',
            '.redpacket-short-touch'
        ],
        popup: [
            '#short_touch_land_lottery_land_userMain',
            '[data-short-touch-landing]'
        ],
        popupClose: [
            '.XiWNTcsi',
            '#lottery_close_cotainer .XiWNTcsi'
        ],
        popupButtons: '[role="button"], button'
    };
    const luckyBagPatterns = {
        countdown: /\b\d{1,2}:\d{2}(?::\d{2})?\b/,
        participated: /已参与|已參與/,
        closeAction: /关闭|取消|返回/,
        diamondCount: /总\s*(\d+)\s*钻/
    };
    const luckyBagStateTemplates = {
        popupState: {
            kind: 'missing',
            node: null,
            text: ''
        },
        runtimeState: {
            currentLuckyBagDiamondCount: 0
        },
        runResult: {
            status: '',
            interacted: false,
            exitWaitMs: 0,
            countdownText: '',
            diamondCount: 0
        }
    };

    // 统一整理入口配置，后续新增功能优先往这里扩展。
    function createAutomationOptions(rawOptions = {}) {
        return {
            entranceUrl: rawOptions.entranceUrl || 'https://www.douyin.com',
            recommendUrl: rawOptions.recommendUrl || 'https://www.douyin.com',
            diamondRange: rawOptions.diamondRange || ''
        };
    }

    const recentLiveStore = {
        prune() {
            try {
                const now = Date.now();
                const keys = [];
                for (let i = 0; i < sessionStorage.length; i += 1) {
                    const key = sessionStorage.key(i);
                    if (key && key.startsWith(recentLivePrefix)) {
                        keys.push(key);
                    }
                }

                for (const key of keys) {
                    const time = Number(sessionStorage.getItem(key) || '0');
                    if (!time || now - time > config.recentLiveTtlMs) {
                        sessionStorage.removeItem(key);
                    }
                }
            } catch (_) {
            }
        },
        getKey(identity) {
            return `${recentLivePrefix}${hashString(identity || 'unknown')}`;
        },
        has(identity) {
            if (!identity) {
                return false;
            }

            recentLiveStore.prune();

            try {
                const key = recentLiveStore.getKey(identity);
                const time = Number(sessionStorage.getItem(key) || '0');
                return Boolean(time) && Date.now() - time <= config.recentLiveTtlMs;
            } catch (_) {
                return false;
            }
        },
        mark(identity) {
            if (!identity) {
                return;
            }

            try {
                sessionStorage.setItem(recentLiveStore.getKey(identity), String(Date.now()));
            } catch (_) {
            }
        }
    };

    // 直播间内和福袋相关的动作都集中放在这里，方便后续继续加功能。
    const luckyBagFlow = {
        getEntryContainer(node) {
            let current = node;

            for (let i = 0; i < 5 && current; i += 1) {
                if (!isVisible(current)) {
                    current = current.parentElement;
                    continue;
                }

                const hasCountdown = luckyBagPatterns.countdown.test(getText(current));
                const hasLotteryImage = Boolean(current.querySelector?.(luckyBagSelectors.entryImages.join(', ')));
                const hasRedpacket = Boolean(current.querySelector?.('.redpacket'));
                const area = getNodeRectArea(current);

                if (area >= 300 && area <= 120000 && (hasCountdown || hasLotteryImage || hasRedpacket)) {
                    return current;
                }

                current = current.parentElement;
            }

            return node;
        },
        findEntryNode() {
            const imageNode = findFirstVisible(luckyBagSelectors.entryImages);
            if (imageNode) {
                return luckyBagFlow.getEntryContainer(imageNode);
            }

            const countdownNode = getVisibleNodeTextCandidates()
                .filter((item) => luckyBagPatterns.countdown.test(item.text))
                .map((item) => item.node)
                .find((node) => {
                    const container = luckyBagFlow.getEntryContainer(node);
                    return isVisible(container) && getNodeRectArea(container) > 0;
                });
            if (countdownNode) {
                return luckyBagFlow.getEntryContainer(countdownNode);
            }

            return findFirstVisible(luckyBagSelectors.entryFallback);
        },
        getCountdownInfo(node) {
            const sourceNode = node || luckyBagFlow.findEntryNode();
            if (!sourceNode) {
                return {
                    text: '',
                    ms: 0
                };
            }

            const sourceText = getText(sourceNode);
            const match = sourceText.match(luckyBagPatterns.countdown);
            if (!match) {
                return {
                    text: '',
                    ms: 0
                };
            }

            const countdownText = match[0];
            const parts = countdownText.split(':').map((item) => Number(item));
            if (parts.some((item) => Number.isNaN(item))) {
                return {
                    text: countdownText,
                    ms: 0
                };
            }

            let totalSeconds = 0;
            if (parts.length === 2) {
                totalSeconds = (parts[0] * 60) + parts[1];
            } else if (parts.length === 3) {
                totalSeconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
            }

            return {
                text: countdownText,
                ms: totalSeconds > 0 ? totalSeconds * 1000 : 0
            };
        },
        getDiamondCount(source) {
            const sourceText = typeof source === 'string' ? source : getText(source);
            const diamondMatch = sourceText.match(luckyBagPatterns.diamondCount);
            if (!diamondMatch) {
                return 0;
            }

            const diamondCount = Number(diamondMatch[1]);
            return Number.isFinite(diamondCount) ? diamondCount : 0;
        },
        syncPopupDiamondCount(popupText, runtimeState) {
            if (!runtimeState) {
                return 0;
            }

            const diamondCount = luckyBagFlow.getDiamondCount(popupText);
            if (diamondCount > 0) {
                runtimeState.currentLuckyBagDiamondCount = diamondCount;
                emitPageAgentEvent('lucky-bag', {
                    stage: 'diamond-detected',
                    diamondCount
                });
            }

            return runtimeState.currentLuckyBagDiamondCount;
        },
        getExitWaitMs(countdownInfo) {
            const countdownMs = countdownInfo?.ms || 0;
            if (countdownMs <= 0) {
                return 0;
            }

            return countdownMs + config.luckyBagExitBufferMs;
        },
        getPopup() {
            const popup = document.querySelector(luckyBagSelectors.popup[0])
                || document.querySelector(luckyBagSelectors.popup[1]);
            return isVisible(popup) ? popup : null;
        },
        closePopup(popup) {
            if (!popup) {
                return false;
            }

            const closeButton = findFirstVisible(luckyBagSelectors.popupClose, popup);
            if (closeButton && humanClick(closeButton)) {
                return true;
            }

            return humanClickCorner(popup);
        },
        async waitForEntry(timeoutMs) {
            const startTime = Date.now();

            while (Date.now() - startTime < timeoutMs) {
                const entryNode = luckyBagFlow.findEntryNode();
                if (entryNode) {
                    return entryNode;
                }

                await wait(config.luckyBagEntryPollMs);
            }

            return null;
        },
        getPopupState(popup, popupText = '') {
            if (!popup) {
                return { ...luckyBagStateTemplates.popupState };
            }

            const resolvedPopupText = popupText || getText(popup);
            const candidates = Array.from(popup.querySelectorAll(luckyBagSelectors.popupButtons))
                .filter((node) => isVisible(node))
                .map((node) => ({
                    node,
                    text: getText(node)
                }))
                .filter((item) => item.text || item.node);

            if (luckyBagPatterns.participated.test(resolvedPopupText)) {
                return {
                    ...luckyBagStateTemplates.popupState,
                    kind: 'already',
                    text: resolvedPopupText
                };
            }

            const actionNode = candidates.find((item) => !luckyBagPatterns.closeAction.test(item.text))
                || candidates[0];
            if (actionNode) {
                return {
                    ...luckyBagStateTemplates.popupState,
                    kind: 'action',
                    node: actionNode.node,
                    text: actionNode.text || ''
                };
            }

            return {
                ...luckyBagStateTemplates.popupState,
                kind: 'waiting',
                text: resolvedPopupText
            };
        },
        async handlePopup(contentIndex, clickIndex, runtimeState) {
            let interacted = false;
            let lastKind = '';
            let actionClickCount = 0;

            for (let i = 0; i < 12; i += 1) {
                const currentPopup = luckyBagFlow.getPopup();
                if (!currentPopup) {
                    return {
                        closed: true,
                        interacted,
                        kind: lastKind || 'closed'
                    };
                }

                const popupText = getText(currentPopup);
                const currentLuckyBagDiamondCount = luckyBagFlow.syncPopupDiamondCount(popupText, runtimeState);
                const popupState = luckyBagFlow.getPopupState(currentPopup, popupText);

                if (i === 0 || popupState.kind !== lastKind) {
                    const diamondText = currentLuckyBagDiamondCount > 0 ? ` | 总${currentLuckyBagDiamondCount}钻` : '';
                    setLogRemember(`第 ${contentIndex} 条内容第 ${clickIndex} 次福袋弹窗类型：${popupState.kind}${popupState.text ? ` | ${popupState.text}` : ''}${diamondText}`);
                    lastKind = popupState.kind;
                }

                if (currentLuckyBagDiamondCount > 0 && !isDiamondRangeMatched(currentLuckyBagDiamondCount)) {
                    const closed = luckyBagFlow.closePopup(currentPopup);
                    setLogRemember(`第 ${contentIndex} 条内容当前福袋总钻石 ${currentLuckyBagDiamondCount}，不符合钻石区间 ${automationOptions.diamondRange}，结束当前直播间并继续刷视频`);
                    await wait(config.luckyBagPopupActionRetryMs);
                    return {
                        closed,
                        interacted: false,
                        kind: 'diamond-range-mismatch'
                    };
                }

                if (popupState.kind === 'already') {
                    const closed = luckyBagFlow.closePopup(currentPopup);
                    setLogRemember(`第 ${contentIndex} 条内容当前福袋显示已参与，${closed ? '已关闭弹窗并结束' : '关闭弹窗失败，仍结束'}当前直播间福袋流程`);
                    await wait(config.luckyBagPopupActionRetryMs);
                    return {
                        closed,
                        interacted: true,
                        kind: 'already'
                    };
                }

                if (popupState.kind === 'action' && popupState.node) {
                    actionClickCount += 1;
                    const diamondText = currentLuckyBagDiamondCount > 0 ? `，福袋总钻石 ${currentLuckyBagDiamondCount}` : '';
                    setLogRemember(`第 ${contentIndex} 条内容第 ${clickIndex} 次福袋弹窗内，第 ${actionClickCount} 次点击领取按钮${popupState.text ? `：${popupState.text}` : ''}${diamondText}`);
                    interacted = true;
                    humanClick(popupState.node);
                    await wait(config.luckyBagPopupClickWaitMs);
                    continue;
                }

                await wait(config.luckyBagPopupActionRetryMs);
            }

            return {
                closed: !luckyBagFlow.getPopup(),
                interacted,
                kind: lastKind || 'waiting'
            };
        },
        async runInLiveRoom(contentIndex) {
            const firstEntry = await luckyBagFlow.waitForEntry(config.luckyBagEntryTimeoutMs);
            const runtimeState = createLuckyBagRuntimeState();
            if (!firstEntry) {
                setLogRemember(`第 ${contentIndex} 条内容进入直播间后，等待 ${Math.round(config.luckyBagEntryTimeoutMs / 1000)} 秒仍未在左上区域找到福袋入口`);
                return createLuckyBagRunResult({
                    status: 'missing-entry',
                    diamondCount: runtimeState.currentLuckyBagDiamondCount
                });
            }

            setLogRemember(`第 ${contentIndex} 条内容已找到左上角福袋入口，开始循环尝试抢福袋`);

            const startTime = Date.now();
            let clickIndex = 0;
            let interacted = false;
            let idleStartTime = 0;
            let latestCountdownInfo = luckyBagFlow.getCountdownInfo(firstEntry);

            if (latestCountdownInfo.ms > 0) {
                setLogRemember(`第 ${contentIndex} 条内容检测到福袋倒计时 ${latestCountdownInfo.text}，领取完成后会额外等待 2 秒再退出直播间`);
            }

            while (Date.now() - startTime < config.luckyBagTotalTimeoutMs) {
                const currentEntryNode = luckyBagFlow.findEntryNode();
                const currentCountdownInfo = luckyBagFlow.getCountdownInfo(currentEntryNode);
                if (currentCountdownInfo.ms > 0) {
                    latestCountdownInfo = currentCountdownInfo;
                }

                const popup = luckyBagFlow.getPopup();
                if (popup) {
                    clickIndex += 1;
                    const popupResult = await luckyBagFlow.handlePopup(contentIndex, clickIndex, runtimeState);
                    interacted = interacted || popupResult.interacted;
                    idleStartTime = 0;

                    if (popupResult.kind === 'already') {
                        return createLuckyBagRunResult({
                            status: 'already-participated',
                            interacted: true,
                            exitWaitMs: luckyBagFlow.getExitWaitMs(latestCountdownInfo),
                            countdownText: latestCountdownInfo.text,
                            diamondCount: runtimeState.currentLuckyBagDiamondCount
                        });
                    }

                    if (popupResult.kind === 'diamond-range-mismatch') {
                        return createLuckyBagRunResult({
                            status: 'diamond-range-mismatch',
                            interacted: false,
                            countdownText: latestCountdownInfo.text,
                            diamondCount: runtimeState.currentLuckyBagDiamondCount
                        });
                    }

                    await wait(config.luckyBagPopupActionRetryMs);
                    continue;
                }

                if (currentEntryNode) {
                    clickIndex += 1;
                    idleStartTime = 0;
                    const clicked = humanClick(currentEntryNode);
                    setLogRemember(`第 ${contentIndex} 条内容第 ${clickIndex} 次点击左上角福袋入口${clicked ? '成功，等待弹窗出现' : '失败'}`);
                    await wait(config.luckyBagEntryClickWaitMs);
                    continue;
                }

                if (!idleStartTime) {
                    idleStartTime = Date.now();
                }

                if (Date.now() - idleStartTime >= config.luckyBagIdleFinishMs) {
                    setLogRemember(`第 ${contentIndex} 条内容连续 ${Math.round(config.luckyBagIdleFinishMs / 1000)} 秒未再看到福袋入口或弹窗，结束当前直播间福袋流程`);
                    return createLuckyBagRunResult({
                        status: interacted ? 'completed' : 'idle-finished',
                        interacted,
                        exitWaitMs: interacted ? luckyBagFlow.getExitWaitMs(latestCountdownInfo) : 0,
                        countdownText: latestCountdownInfo.text,
                        diamondCount: runtimeState.currentLuckyBagDiamondCount
                    });
                }

                await wait(config.luckyBagIdlePollMs);
            }

            setLogRemember(`第 ${contentIndex} 条内容直播间福袋流程达到总超时，准备退出直播间`);
            return createLuckyBagRunResult({
                status: interacted ? 'timeout-after-action' : 'timeout',
                interacted,
                exitWaitMs: interacted ? luckyBagFlow.getExitWaitMs(latestCountdownInfo) : 0,
                countdownText: latestCountdownInfo.text,
                diamondCount: runtimeState.currentLuckyBagDiamondCount
            });
        }
    };

    function createLuckyBagRuntimeState(overrides = {}) {
        return {
            ...luckyBagStateTemplates.runtimeState,
            ...overrides
        };
    }

    function createLuckyBagRunResult(overrides = {}) {
        return {
            ...luckyBagStateTemplates.runResult,
            ...overrides
        };
    }

    // 通过页面桥接层上报结构化事件，不影响原有页面流程。
    function emitPageAgentEvent(type, payload = {}) {
        try {
            window.__douyinPageAgentBridge?.emit?.(type, payload);
        } catch (_) {
        }
    }

    function formatLuckyBagDiamondText(diamondCount) {
        return diamondCount > 0 ? `，福袋总钻石 ${diamondCount}` : '';
    }

    // 根据页面配置判断当前福袋钻石数是否命中筛选区间。
    function isDiamondRangeMatched(diamondCount) {
        const diamondRange = automationOptions.diamondRange;
        if (!diamondRange || diamondCount <= 0) {
            return true;
        }

        if (diamondRange === '1-100') {
            return diamondCount >= 1 && diamondCount <= 100;
        }

        if (diamondRange === '101-200') {
            return diamondCount >= 101 && diamondCount <= 200;
        }

        if (diamondRange === '201-300') {
            return diamondCount >= 201 && diamondCount <= 300;
        }

        if (diamondRange === '301+') {
            return diamondCount >= 301;
        }

        return true;
    }

    // 自动流程总入口，只负责分发到推荐页流程或直播间流程。
    async function startFlow() {
        if (state.running) {
            return { status: 'already-running' };
        }

        try {
            const livePageChecker = typeof isLivePage === 'function'
                ? isLivePage
                : () => location.hostname.includes('live.douyin.com') || location.pathname.includes('/root/live/');

            if (livePageChecker()) {
                state.running = true;
                setLogRemember('当前页面已在直播间，直接执行福袋流程');
                return await runLiveRoomStandalone();
            }

            return await ensureRecommendPage();
        } catch (error) {
            state.running = false;
            const message = `脚本执行异常：${error?.message || error}`;
            setLogRemember(message);
            return {
                status: 'error',
                retryable: true,
                retryDelayMs: 3000,
                message
            };
        }
    }

    // 外部停止时只改运行状态，让当前流程在安全位置自然退出。
    function stopFlow() {
        state.running = false;
        if (state.recommendSideSyncTimer) {
            clearTimeout(state.recommendSideSyncTimer);
            state.recommendSideSyncTimer = null;
        }
        setLogRemember('收到停止指令，当前自动流程会在安全节点退出');
        return { status: 'stopping' };
    }

    // 进入推荐页前的统一检查，保持现有站点检查和点推荐顺序不变。
    async function ensureRecommendPage() {
        if (!location.hostname.includes('douyin.com')) {
            setLogRemember(`当前页面不是抖音站点，准备跳转：${location.href}`);
            location.href = entranceUrl;
            return { status: 'redirecting-site' };
        }

        if (hasLoginButton()) {
            const message = '检测到登录按钮，等待手动登录后由入口继续重试';
            setLogRemember(message);
            return {
                status: 'need-login',
                retryable: true,
                retryDelayMs: 5000,
                message
            };
        }

        setLogRemember('未检测到登录按钮，当前状态视为已登录');

        const recommendPageChecker = isRecommendPage;

        if (recommendPageChecker()) {
            state.running = true;
            setLogRemember(`当前页面是抖音推荐页：${location.href}`);
            scheduleRecommendPageSideSync();
            await runRecommendationLoop();
            return { status: 'running-loop' };
        }

        setLogRemember(`当前页面不是抖音推荐页：${location.href}，准备点击推荐入口`);
        const clicked = goToRecommendPage();
        return {
            status: clicked ? 'redirecting-recommend' : 'waiting-recommend-entry',
            retryable: true,
            retryDelayMs: 2000
        };
    }

    // 推荐页主循环，负责持续刷内容并把命中的直播交给后续流程处理。
    async function runRecommendationLoop() {
        setLogRemember('已进入推荐页，等待页面稳定');
        await wait(config.recommendPageInitialWaitMs);
        setLogRemember('-----开始自动刷视频-------');
        let contentIndex = 1;
        let currentSnapshot = await waitForStableContent('', config.contentStableTimeoutMs);

        if (!currentSnapshot) {
            currentSnapshot = getCurrentContentSnapshot();
        }

        if (!currentSnapshot?.marker) {
            setLogRemember('当前页内容还没完全稳定，先从第 1 条内容开始继续记录');
        }

        currentSnapshot = await processCurrentContent(contentIndex, currentSnapshot);
        await wait(config.contentStayMs);

        while (state.running) {
            const oldMarker = currentSnapshot?.marker || getCurrentContentSnapshot().marker;
            const switchStartTime = Date.now();
            await triggerNextContent();

            const nextSnapshot = await waitForContentChange(oldMarker, config.contentSwitchTimeoutMs);
            if (!nextSnapshot?.marker) {
                setLogRemember(`当前仍停留在第 ${contentIndex} 条内容，未确认切到下一条`);
                continue;
            }

            if (nextSnapshot.marker === oldMarker) {
                setLogRemember(`当前仍停留在第 ${contentIndex} 条内容，页面指纹没有变化`);
                continue;
            }

            contentIndex += 1;
            currentSnapshot = nextSnapshot;
            setLogRemember(`切换到第 ${contentIndex} 条内容成功，耗时 ${Date.now() - switchStartTime} ms`);
            currentSnapshot = await processCurrentContent(contentIndex, currentSnapshot);
            await wait(config.contentStayMs);
        }

        state.running = false;
        setLogRemember('推荐页主循环已停止');
        return { status: 'stopped' };
    }

    // 推荐页展示信息走旁路同步，避免阻塞主流程的日志框和自动刷视频。
    function scheduleRecommendPageSideSync() {
        if (state.recommendSideSyncTimer) {
            clearTimeout(state.recommendSideSyncTimer);
            state.recommendSideSyncTimer = null;
        }

        state.recommendSideSyncTimer = setTimeout(() => {
            state.recommendSideSyncTimer = null;
            void runRecommendPageSideSync();
        }, 1200);
    }

    // 平台账号先走旁路同步，避免展示信息阻塞主流程。
    async function runRecommendPageSideSync() {
        if (state.recommendSideSyncRunning || !state.running || isLivePage()) {
            return;
        }

        state.recommendSideSyncRunning = true;
        try {
            await syncCurrentDouyinAccountNameSafely();
        } finally {
            state.recommendSideSyncRunning = false;
        }
    }

    // 当前已经在直播间时，直接执行单次福袋流程并在结束后尝试回推荐页。
    async function runLiveRoomStandalone() {
        await wait(config.liveRoomStableWaitMs);
        const luckyBagResult = await luckyBagFlow.runInLiveRoom('当前');
        setLogRemember(`当前直播间福袋流程结束：${luckyBagResult.status}${formatLuckyBagDiamondText(luckyBagResult.diamondCount)}`);

        if (luckyBagResult.exitWaitMs > 0) {
            const waitSeconds = Math.ceil(luckyBagResult.exitWaitMs / 1000);
            const countdownText = luckyBagResult.countdownText ? `（当前倒计时 ${luckyBagResult.countdownText}）` : '';
            setLogRemember(`等待 ${waitSeconds} 秒后退出直播间${countdownText}`);
            await wait(luckyBagResult.exitWaitMs);
        }

        history.back();
        const returned = await waitForPageState('recommend', config.recommendReturnTimeoutMs);
        state.running = false;

        if (returned) {
            setLogRemember('已返回推荐页，后续由入口继续拉起自动流程');
            return {
                status: 'returned-to-recommend',
                retryable: true,
                retryDelayMs: config.recommendResumeWaitMs
            };
        }

        setLogRemember('回退后没有确认回到推荐页，直接跳转抖音推荐页');
        location.href = recommendUrl;
        return { status: 'redirecting-recommend' };
    }

    function isVisible(node) {
        if (!node) {
            return false;
        }

        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function getText(node) {
        return (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function hashString(text) {
        let hash = 5381;
        const source = String(text || '');

        for (let i = 0; i < source.length; i += 1) {
            hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
        }

        return (hash >>> 0).toString(36);
    }

    function hasLoginButton() {
        return Array.from(document.querySelectorAll('button'))
            .filter((node) => isVisible(node))
            .some((node) => {
                const text = getText(node);
                if (text !== '鐧诲綍') {
                    return false;
                }

                return Boolean(node.closest('#RkbQLUok')) || /鐧诲綍/.test(text);
            });
    }

    async function processCurrentContent(contentIndex, snapshot) {
        let currentSnapshot = snapshot?.marker ? snapshot : getCurrentContentSnapshot();
        currentSnapshot = await waitForFudaiSignals(currentSnapshot, config.fudaiSignalWaitMs);

        const currentContent = logContentType(contentIndex, currentSnapshot);
        if (currentContent.type !== 'fudai-live') {
            return currentSnapshot;
        }

        const entered = await enterFudaiLiveAndReturn(contentIndex, currentSnapshot);
        if (!entered) {
            return currentSnapshot;
        }

        return await waitForStableContent('', config.contentStableTimeoutMs) || getCurrentContentSnapshot();
    }

    function logContentType(contentIndex, snapshot) {
        const currentContent = snapshot?.content || resolveContentType();
        const summaryText = snapshot?.summary ? ` | ${snapshot.summary}` : '';

        if (currentContent.type === 'video') {
            setLogRemember(`第 ${contentIndex} 条内容：普通视频${summaryText}`);
            return currentContent;
        }

        if (currentContent.type === 'normal-live') {
            setLogRemember(`第 ${contentIndex} 条内容：普通直播${summaryText}`);
            return currentContent;
        }

        if (currentContent.type === 'fudai-live') {
            setLogRemember(`第 ${contentIndex} 条内容：福袋直播${summaryText}`);
            return currentContent;
        }

        setLogRemember(`第 ${contentIndex} 条内容：未知${summaryText}`);
        return currentContent;
    }

    function resolveContentType(feedItem) {
        const liveLink = getCurrentLiveLink(feedItem);
        if (!liveLink) {
            return {
                type: 'video',
                isLive: false,
                hasFudai: false,
                liveLink: null
            };
        }

        if (hasFudaiIcon(liveLink) || hasFudaiText(liveLink)) {
            return {
                type: 'fudai-live',
                isLive: true,
                hasFudai: true,
                liveLink
            };
        }

        return {
            type: 'normal-live',
            isLive: true,
            hasFudai: false,
            liveLink
        };
    }

    function getFeedItems() {
        return Array.from(document.querySelectorAll(feedItemSelector))
            .filter((node) => isVisible(node))
            .filter((node) => node.getBoundingClientRect().height > 120);
    }

    function getCurrentFeedItem() {
        const screenCenterY = window.innerHeight / 2;
        const samplePoints = [
            { x: 0.5, y: 0.5, weight: 4 },
            { x: 0.5, y: 0.38, weight: 2 },
            { x: 0.5, y: 0.62, weight: 2 },
            { x: 0.42, y: 0.5, weight: 1 },
            { x: 0.58, y: 0.5, weight: 1 }
        ];
        const hitMap = new Map();

        for (const point of samplePoints) {
            const x = Math.min(window.innerWidth - 1, Math.max(0, Math.round(window.innerWidth * point.x)));
            const y = Math.min(window.innerHeight - 1, Math.max(0, Math.round(window.innerHeight * point.y)));
            const node = document.elementFromPoint(x, y);
            const feedItem = node?.closest?.(feedItemSelector);

            if (!feedItem || !isVisible(feedItem)) {
                continue;
            }

            const score = (hitMap.get(feedItem) || 0) + point.weight;
            hitMap.set(feedItem, score);
        }

        const sampledFeedItem = Array.from(hitMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([node]) => node)[0];

        if (sampledFeedItem) {
            return sampledFeedItem;
        }

        const activeVideo = document.querySelector('[data-e2e="feed-active-video"]');
        const activeFeedItem = activeVideo?.closest?.(feedItemSelector);
        if (activeFeedItem && isVisible(activeFeedItem)) {
            return activeFeedItem;
        }

        const candidates = getFeedItems()
            .map((node) => {
                const rect = node.getBoundingClientRect();
                const centerY = rect.top + rect.height / 2;
                const containsCenter = rect.top <= screenCenterY && rect.bottom >= screenCenterY;

                return {
                    node,
                    rect,
                    containsCenter,
                    distance: Math.abs(centerY - screenCenterY)
                };
            })
            .filter((item) => item.rect.bottom > 0 && item.rect.top < window.innerHeight)
            .sort((a, b) => {
                if (a.containsCenter !== b.containsCenter) {
                    return a.containsCenter ? -1 : 1;
                }

                return a.distance - b.distance;
            });

        return candidates[0]?.node || document.body;
    }

    function getCurrentLiveLink(feedItem) {
        const currentFeedItem = feedItem || getCurrentFeedItem();
        if (!currentFeedItem) {
            return null;
        }

        const selectorGroups = [
            'a.LiveLinkA',
            'a[href*="live.douyin.com"]',
            'a[href*="/root/live/"]'
        ];

        for (const selector of selectorGroups) {
            const candidate = Array.from(currentFeedItem.querySelectorAll(selector))
                .find((node) => isVisible(node));
            if (candidate) {
                return candidate;
            }
        }

        return null;
    }

    function hasFudaiIcon(liveLink) {
        if (!liveLink) {
            return false;
        }

        const containers = [];
        let current = liveLink;

        for (let i = 0; i < 3 && current; i += 1) {
            containers.push(current);
            current = current.parentElement;
        }

        for (const container of containers) {
            const fudaiIcon = container.querySelector('img[src*="lottery"], img[src*="lottery_new"]');
            if (isVisible(fudaiIcon)) {
                return true;
            }
        }

        return false;
    }

    function hasFudaiText(liveLink) {
        if (!liveLink) {
            return false;
        }

        const containers = [];
        let current = liveLink;

        for (let i = 0; i < 3 && current; i += 1) {
            containers.push(current);
            current = current.parentElement;
        }

        return containers.some((container) => /閽荤煶绂忚|瓒呯骇绂忚|绂忚|绾㈠寘/.test(getText(container)));
    }

    function getCurrentFeedSummary(feedItem) {
        const scope = feedItem || getCurrentFeedItem() || document;
        const nicknameNode = scope.querySelector('[data-e2e="feed-video-nickname"]');
        const nickname = normalizeMarkerText(getText(nicknameNode)).replace(/^@/, '');
        if (nickname) {
            return nickname.slice(0, 120);
        }

        return '';
    }

    function getFeedItemFingerprint(feedItem, liveLink) {
        const scope = feedItem || getCurrentFeedItem() || document.body;
        const parts = [];

        const liveUrl = getNodeHref(liveLink);
        if (liveUrl) {
            parts.push(`live:${liveUrl}`);
        }

        const videoNode = scope.querySelector('video');
        const videoSrc = videoNode?.currentSrc || videoNode?.src || videoNode?.getAttribute?.('src') || '';
        const videoPoster = videoNode?.poster || videoNode?.getAttribute?.('poster') || '';
        if (videoSrc) {
            parts.push(`video:${videoSrc.slice(0, 160)}`);
        }
        if (videoPoster) {
            parts.push(`poster:${videoPoster.slice(0, 160)}`);
        }

        const imageSources = Array.from(scope.querySelectorAll('img'))
            .map((img) => img.currentSrc || img.src || img.getAttribute('src') || '')
            .filter(Boolean)
            .slice(0, 6);
        if (imageSources.length > 0) {
            parts.push(`imgs:${imageSources.join('|').slice(0, 400)}`);
        }

        const textSignature = normalizeMarkerText(getText(scope)).slice(0, 220);
        if (textSignature) {
            parts.push(`text:${textSignature}`);
        }

        const liveRect = liveLink?.getBoundingClientRect?.();
        if (liveRect) {
            parts.push(`liveRect:${Math.round(liveRect.left)}:${Math.round(liveRect.top)}:${Math.round(liveRect.width)}:${Math.round(liveRect.height)}`);
        }

        const summaryText = getCurrentFeedSummary(scope);
        if (summaryText) {
            parts.push(`summary:${summaryText}`);
        }

        return hashString(parts.join('__'));
    }

    function normalizeMarkerText(text) {
        return (text || '')
            .replace(/\s+/g, ' ')
            .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
            .replace(/\b\d+\s*绉抃b/g, '')
            .trim();
    }

    function getNodeHref(node) {
        const href = node?.getAttribute?.('href') || node?.href || '';
        if (!href) {
            return '';
        }

        try {
            return new URL(href, location.origin).href;
        } catch (_) {
            return href;
        }
    }

    function dispatchKeyboard(target, key, code, keyCode) {
        try {
            target.dispatchEvent(new KeyboardEvent('keydown', {
                key,
                code,
                keyCode,
                which: keyCode,
                bubbles: true
            }));
        } catch (_) {
        }

        try {
            target.dispatchEvent(new KeyboardEvent('keyup', {
                key,
                code,
                keyCode,
                which: keyCode,
                bubbles: true
            }));
        } catch (_) {
        }
    }

    async function triggerNextContent() {
        try {
            document.body.focus?.();
            window.focus?.();
        } catch (_) {
        }

        try {
            document.body.click();
        } catch (_) {
        }

        await wait(config.nextContentKeyDelayMs);
        dispatchKeyboard(document, 'ArrowDown', 'ArrowDown', 40);
    }

    function isLivePage() {
        return location.hostname.includes('live.douyin.com') || location.pathname.includes('/root/live/');
    }

    const pageStateMatchers = {
        live() {
            if (isLivePage()) {
                return true;
            }

            if (location.href.includes('recommend=1')) {
                return false;
            }

            return getFeedItems().length === 0;
        },
        recommend() {
            return location.href.includes('recommend=1') && getFeedItems().length > 0;
        }
    };

    async function waitForPageState(stateName, timeoutMs) {
        const matcher = pageStateMatchers[stateName];
        if (!matcher) {
            return false;
        }

        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            if (matcher()) {
                return true;
            }

            await wait(config.pageStatePollMs);
        }

        return false;
    }

    function dispatchClick(node, clientX, clientY) {
        if (!node) {
            return false;
        }

        try {
            node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX, clientY }));
            node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
            node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
            return true;
        } catch (_) {
            try {
                node.click();
                return true;
            } catch (_) {
                return false;
            }
        }
    }

    function humanClick(node) {
        if (!node) {
            return false;
        }

        const rect = node.getBoundingClientRect?.();
        const clientX = rect ? rect.left + Math.max(10, Math.min(rect.width - 10, rect.width / 2)) : 12;
        const clientY = rect ? rect.top + Math.max(10, Math.min(rect.height - 10, rect.height / 2)) : 12;
        return dispatchClick(node, clientX, clientY);
    }

    function humanClickCorner(node) {
        if (!node) {
            return false;
        }

        const rect = node.getBoundingClientRect?.();
        const clientX = rect ? rect.left + Math.min(20, Math.max(6, rect.width * 0.08)) : 12;
        const clientY = rect ? rect.top + Math.min(20, Math.max(6, rect.height * 0.08)) : 12;
        return dispatchClick(node, clientX, clientY);
    }

    function findFirstVisible(selectors, root) {
        const scope = root || document;

        for (const selector of selectors) {
            const node = Array.from(scope.querySelectorAll(selector)).find((item) => isVisible(item));
            if (node) {
                return node;
            }
        }

        return null;
    }

    function getVisibleNodeTextCandidates(root) {
        return Array.from((root || document).querySelectorAll('*'))
            .filter((node) => isVisible(node))
            .map((node) => ({
                node,
                text: getText(node)
            }))
            .filter((item) => item.text);
    }

    function getNodeRectArea(node) {
        const rect = node?.getBoundingClientRect?.();
        if (!rect) {
            return 0;
        }

        return Math.max(0, rect.width) * Math.max(0, rect.height);
    }

    function getLiveIdentity(liveLink, snapshot) {
        const liveUrl = getNodeHref(liveLink);
        if (liveUrl) {
            return liveUrl;
        }

        if (snapshot?.marker) {
            return snapshot.marker;
        }

        return hashString(getText(liveLink) || 'unknown-live');
    }

    async function enterFudaiLiveAndReturn(contentIndex, snapshot) {
        const currentContent = snapshot?.content || {};
        const liveLink = currentContent.liveLink || getCurrentLiveLink();

        if (!liveLink) {
            setLogRemember(`第 ${contentIndex} 条内容标记为福袋直播，但没找到可进入的直播入口`);
            return false;
        }

        const liveIdentity = getLiveIdentity(liveLink, snapshot);
        if (recentLiveStore.has(liveIdentity)) {
            setLogRemember(`第 ${contentIndex} 条内容刚刚已经进入过同一直播间，先跳过`);
            return false;
        }

        try {
            if (liveLink.getAttribute?.('target')) {
                liveLink.setAttribute('target', '_self');
            }
        } catch (_) {
        }

        setLogRemember(`第 ${contentIndex} 条内容准备点击直播入口进入福袋直播间`);
        const clicked = humanClick(liveLink);
        if (!clicked) {
            setLogRemember(`第 ${contentIndex} 条内容点击直播入口失败，取消进入直播间`);
            return false;
        }

        const entered = await waitForPageState('live', config.liveRoomEnterTimeoutMs);
        if (!entered) {
            setLogRemember(`第 ${contentIndex} 条内容点击后没有确认进入直播间，继续留在推荐页`);
            return false;
        }

        recentLiveStore.mark(liveIdentity);
        setLogRemember(`第 ${contentIndex} 条内容已经进入直播间，等待页面稳定后开始抢福袋`);
        await wait(config.liveRoomStableWaitMs);
        const luckyBagResult = await luckyBagFlow.runInLiveRoom(contentIndex);
        setLogRemember(`第 ${contentIndex} 条内容直播间福袋流程结束：${luckyBagResult.status}${formatLuckyBagDiamondText(luckyBagResult.diamondCount)}`);

        if (luckyBagResult.exitWaitMs > 0) {
            const waitSeconds = Math.ceil(luckyBagResult.exitWaitMs / 1000);
            const countdownText = luckyBagResult.countdownText ? `（当前倒计时 ${luckyBagResult.countdownText}）` : '';
            setLogRemember(`第 ${contentIndex} 条内容等待 ${waitSeconds} 秒后退出直播间${countdownText}`);
            await wait(luckyBagResult.exitWaitMs);
        }

        history.back();
        const returned = await waitForPageState('recommend', config.recommendReturnTimeoutMs);
        if (!returned) {
            setLogRemember(`第 ${contentIndex} 条内容回退后没有确认回到推荐页，请手动观察`);
            return false;
        }

        setLogRemember(`第 ${contentIndex} 条内容已返回推荐页，后续由主循环继续切到下一条内容`);
        await wait(config.recommendResumeWaitMs);
        return true;
    }

    function getCurrentContentSnapshot() {
        const feedItem = getCurrentFeedItem();
        const feedSummary = getCurrentFeedSummary(feedItem);
        const liveLink = getCurrentLiveLink(feedItem);
        const content = resolveContentType(feedItem);
        const feedFingerprint = getFeedItemFingerprint(feedItem, liveLink);
        if (liveLink) {
            const liveUrl = getNodeHref(liveLink);
            const markerBase = feedFingerprint || liveUrl || feedSummary || 'unknown';
            const observeKey = `live:${String(markerBase).slice(0, 180)}`;

            return {
                marker: observeKey,
                observeKey,
                identity: observeKey,
                summary: feedSummary,
                content
            };
        }

        const observeKeyBase = feedFingerprint || feedSummary;
        if (observeKeyBase) {
            const observeKey = `video:${String(observeKeyBase).slice(0, 180)}`;
            return {
                marker: observeKey,
                observeKey,
                identity: observeKey,
                summary: feedSummary,
                content
            };
        }

        const centerNode = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        const centerText = normalizeMarkerText(centerNode?.innerText || centerNode?.textContent || '').slice(0, 100);
        const observeKey = centerText ? `page:${centerText}` : '';

        return {
            marker: observeKey,
            observeKey,
            identity: observeKey,
            summary: '',
            content: resolveContentType(feedItem)
        };
    }

    async function waitForFudaiSignals(snapshot, timeoutMs) {
        const initialSnapshot = snapshot || getCurrentContentSnapshot();
        const initialIdentity = initialSnapshot?.identity || initialSnapshot?.observeKey || initialSnapshot?.marker;

        if (!initialIdentity || !initialSnapshot?.content?.isLive || initialSnapshot.content.hasFudai) {
            return initialSnapshot;
        }

        let latestSnapshot = initialSnapshot;
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            await wait(config.fudaiSignalPollMs);
            latestSnapshot = getCurrentContentSnapshot();
            const latestIdentity = latestSnapshot?.identity || latestSnapshot?.observeKey || latestSnapshot?.marker;

            if (!latestIdentity || latestIdentity !== initialIdentity) {
                return latestSnapshot;
            }

            if (latestSnapshot?.content?.type === 'fudai-live') {
                setLogRemember('当前直播的福袋标记延迟出现，已升级识别为福袋直播');
                return latestSnapshot;
            }
        }

        return latestSnapshot;
    }

    recentLiveStore.prune();

    async function waitForSnapshot(snapshotOptions) {
        const { timeoutMs, stableMs, isMatch } = snapshotOptions;
        const startTime = Date.now();
        let candidateSnapshot = null;
        let candidateTime = 0;

        while (Date.now() - startTime < timeoutMs) {
            const snapshot = getCurrentContentSnapshot();
            const marker = snapshot.observeKey || snapshot.marker;

            if (isMatch(snapshot, marker)) {
                if (!candidateSnapshot || marker !== (candidateSnapshot.observeKey || candidateSnapshot.marker)) {
                    candidateSnapshot = snapshot;
                    candidateTime = Date.now();
                }

                if (Date.now() - candidateTime >= stableMs) {
                    return candidateSnapshot;
                }
            } else {
                candidateSnapshot = null;
                candidateTime = 0;
            }

            await wait(config.pageStatePollMs);
        }

        return candidateSnapshot;
    }

    async function waitForContentChange(previousMarker, timeoutMs) {
        return waitForSnapshot({
            timeoutMs,
            stableMs: config.contentChangeStableMs,
            isMatch(_snapshot, marker) {
                return Boolean(marker) && marker !== previousMarker;
            }
        });
    }

    async function waitForStableContent(excludedMarker, timeoutMs) {
        return waitForSnapshot({
            timeoutMs,
            stableMs: config.contentReadyStableMs,
            isMatch(_snapshot, marker) {
                return Boolean(marker) && marker !== excludedMarker;
            }
        });
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // 首页会自动落到精选页，因此首页和精选页都视为进入推荐前的可读余额页面。
    function shouldSyncDiamondBalanceBeforeRecommend() {
        const url = location.href || '';
        return url === 'https://www.douyin.com/'
            || url === 'https://www.douyin.com'
            || url.startsWith('https://www.douyin.com/jingxuan');
    }

    // 读取当前登录抖音账号名，并通过页面事件桥同步给上层。
    async function syncCurrentDouyinAccountName() {
        let accountName = getCurrentDouyinAccountName();
        if (!accountName) {
            await revealCurrentDouyinAccountPanel();
            accountName = await waitForCurrentDouyinAccountName(4000);
        }

        if (!accountName || accountName === state.currentAccountName) {
            return accountName;
        }

        state.currentAccountName = accountName;
        emitPageAgentEvent('account', {
            accountName
        });
        setLogRemember(`当前抖音账号：${accountName}`);
        return accountName;
    }

    // 账号名同步只用于表格展示，失败时不影响自动刷视频主流程。
    async function syncCurrentDouyinAccountNameSafely() {
        try {
            return await syncCurrentDouyinAccountName();
        } catch (error) {
            setLogRemember(`同步抖音账号失败：${error?.message || error}`);
            return '';
        }
    }

    // 仅在首页同步一次钻石余额，读取完成后关闭弹窗。
    async function syncCurrentDiamondBalance() {
        setLogRemember('开始同步钻石余额');
        const entryNode = await waitForRechargeEntryNode(5000);
        if (!entryNode) {
            setLogRemember('未找到钻石余额入口，跳过本次余额同步');
            return 0;
        }

        humanClick(entryNode);
        const balanceAmountNode = await waitForDiamondBalanceAmountNode(5000);
        const diamondBalance = getDiamondBalanceAmount(balanceAmountNode);
        if (diamondBalance <= 0) {
            setLogRemember('未读取到钻石余额数字，跳过本次余额同步');
        }
        if (diamondBalance > 0 && diamondBalance !== state.currentDiamondBalance) {
            state.currentDiamondBalance = diamondBalance;
            emitPageAgentEvent('balance', {
                diamondBalance
            });
            setLogRemember(`当前钻石余额：${diamondBalance}`);
        }

        const closeNode = getRechargeCloseNode();
        if (closeNode) {
            humanClick(closeNode);
            await wait(300);
        }

        return diamondBalance;
    }

    // 读取余额属于附加信息，同步失败时不要阻断主流程继续刷视频。
    async function syncCurrentDiamondBalanceSafely() {
        try {
            return await syncCurrentDiamondBalance();
        } catch (error) {
            setLogRemember(`同步钻石余额失败：${error?.message || error}`);
            return 0;
        }
    }

    // 从右上角个人面板读取当前登录抖音账号名。
    function getCurrentDouyinAccountName() {
        const accountLink = getCurrentDouyinAccountLink();
        return normalizeDouyinAccountNameText(accountLink);
    }

    async function waitForCurrentDouyinAccountName(timeoutMs) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const accountName = getCurrentDouyinAccountName();
            if (accountName) {
                return accountName;
            }

            await wait(200);
        }

        setLogRemember('未找到抖音账号节点，跳过本次账号同步');
        return '';
    }

    async function revealCurrentDouyinAccountPanel() {
        const triggerNodes = getCurrentDouyinAccountHoverTargets();
        if (!triggerNodes.length) {
            return false;
        }

        for (const triggerNode of triggerNodes) {
            dispatchHover(triggerNode);
            await wait(180);
        }

        await wait(500);
        return true;
    }

    // 账号面板通常由头像区域 hover 触发，这里统一返回可尝试 hover 的入口节点。
    function getCurrentDouyinAccountHoverTargets() {
        const avatarNode = document.querySelector('span[data-e2e="live-avatar"]');
        if (!avatarNode) {
            return [];
        }

        const avatarLink = avatarNode.closest('a[href*="/user/self"]');
        const rootContainer = avatarLink?.closest('div.H34WoWC7') || avatarLink?.parentElement?.parentElement || null;

        return [avatarLink, avatarNode, rootContainer].filter((node, index, list) => {
            return Boolean(node) && list.indexOf(node) === index;
        });
    }

    // 先从账号面板固定结构里找名称链接，最后再做一次窄范围兜底。
    function getCurrentDouyinAccountLink() {
        for (const root of getCurrentDouyinAccountRootCandidates()) {
            const primaryLink = root.querySelector('.NeAI6YYW .SgbdwJuv > a[href*="enter_method=personal_panel"]');
            if (normalizeDouyinAccountNameText(primaryLink)) {
                return primaryLink;
            }

            const fallbackLink = root.querySelector('.NeAI6YYW a.e6huIECy[href*="/user/self"]');
            if (normalizeDouyinAccountNameText(fallbackLink)) {
                return fallbackLink;
            }
        }

        return Array.from(document.querySelectorAll('a[href*="/user/self"][href*="enter_method=personal_panel"]'))
            .find((node) => {
                const href = getNodeHref(node);
                const text = normalizeDouyinAccountNameText(node);
                return Boolean(text) && !href.includes('showTab=');
            }) || null;
    }

    // 个人面板根节点和头像容器都可能持有账号链接，按优先级依次尝试。
    function getCurrentDouyinAccountRootCandidates() {
        const panelRoot = document.querySelector('.Q6VYnosf.userMenuPanelShadowAnimation');
        return [
            panelRoot,
            panelRoot?.querySelector('.l1obMd7E'),
            document.querySelector('div.H34WoWC7')
        ].filter(Boolean);
    }

    // 清洗账号节点文本，过滤无效文案后返回真正的账号名。
    function normalizeDouyinAccountNameText(node) {
        const text = getText(node);
        if (!text || text === '我的' || text === '@我的') {
            return '';
        }

        return text.replace(/^@/, '').slice(0, 120);
    }

    function dispatchHover(node) {
        if (!node) {
            return;
        }

        const rect = node.getBoundingClientRect?.();
        const clientX = rect ? rect.left + Math.max(8, Math.min(rect.width - 8, rect.width / 2)) : 12;
        const clientY = rect ? rect.top + Math.max(8, Math.min(rect.height - 8, rect.height / 2)) : 12;
        const eventInit = {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY
        };

        try {
            node.dispatchEvent(new MouseEvent('mouseenter', eventInit));
            node.dispatchEvent(new MouseEvent('mouseover', eventInit));
            node.dispatchEvent(new MouseEvent('mousemove', eventInit));
        } catch (_) {
            // noop
        }
    }

    function getRechargeEntryNode() {
        const preciseNode = document.querySelector(
            '.dYcWlUlB .cbBVPXaz .Xu0nlrYh div.vUlcfDbY.d5oQ4GPx[data-e2e="something-button"]'
        );
        if (isVisible(preciseNode)) {
            return preciseNode;
        }

        const baseNode = Array.from(document.querySelectorAll('div[data-e2e="something-button"]'))
            .find((node) => isVisible(node));
        if (!baseNode) {
            return null;
        }

        let current = baseNode;
        for (let i = 0; i < 3 && current; i += 1) {
            if (isVisible(current)) {
                return current;
            }
            current = current.parentElement;
        }

        return baseNode;
    }

    async function waitForRechargeEntryNode(timeoutMs) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const entryNode = getRechargeEntryNode();
            if (entryNode) {
                return entryNode;
            }

            await wait(200);
        }

        return null;
    }

    async function waitForDiamondBalanceAmountNode(timeoutMs) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const amountNode = document.querySelector('.recharge-header-balance .balance-amount');
            if (isVisible(amountNode)) {
                return amountNode;
            }

            await wait(200);
        }

        return null;
    }

    function getDiamondBalanceAmount(amountNode) {
        const amountText = getText(amountNode).replace(/[^\d]/g, '');
        const amount = Number(amountText);
        return Number.isFinite(amount) ? amount : 0;
    }

    function getRechargeCloseNode() {
        const closeNode = document.querySelector('.recharge-header-close');
        return isVisible(closeNode) ? closeNode : null;
    }

    function getRecommendNavCandidates() {
        return Array.from(document.querySelectorAll('a, button, div[role="button"]'))
            .filter((node) => isVisible(node))
            .map((node) => ({
                node,
                text: getText(node)
            }))
            .filter((item) => item.text === '推荐' || /(^|\s)推荐(\s|$)/.test(item.text));
    }

    // 推荐页跳转保持简单处理：找到“推荐”节点后直接模拟点击。
    function goToRecommendPage() {
        const recommendCandidates = getRecommendNavCandidates();
        const recommendLink = recommendCandidates
            .map((item) => item.node)
            .find((node) => {
                const href = getNodeHref(node);
                return href.includes('recommend=1');
            }) || recommendCandidates[0]?.node;

        if (recommendLink) {
            humanClick(recommendLink);
            setLogRemember('已找到推荐入口并执行点击');
            return true;
        }

        setLogRemember('没有找到推荐入口，等待页面出现推荐入口后重试');
        return false;
    }

    function ensureLogBox() {
        if (!document.body) {
            return null;
        }

        if (state.logBox && document.body.contains(state.logBox)) {
            return state.logBox;
        }

        const box = document.createElement('div');
        box.id = 'douyin-fudai-log-box';
        box.style.position = 'fixed';
        box.style.right = '16px';
        box.style.bottom = '100px';
        box.style.zIndex = '2147483647';
        box.style.width = '360px';
        box.style.maxHeight = '240px';
        box.style.overflowY = 'auto';
        box.style.padding = '10px';
        box.style.background = 'rgba(0, 0, 0, 0.78)';
        box.style.color = '#fff';
        box.style.fontSize = '12px';
        box.style.lineHeight = '1.5';
        box.style.borderRadius = '8px';
        box.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.25)';
        box.style.whiteSpace = 'pre-wrap';
        box.style.wordBreak = 'break-all';
        document.body.appendChild(box);
        state.logBox = box;
        return box;
    }

    function setLogRemember(message) {
        const text = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`;
        console.log(`${pageLogPrefix} ${text}`);
        emitPageAgentEvent('log', { message, text });

        const box = ensureLogBox();
        if (!box) {
            return;
        }

        const line = document.createElement('div');
        line.textContent = text;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }

    const api = {
        startFlow,
        stopFlow,
        ensureRecommendPage,
        runLiveRoomStandalone,
        isLivePage
    };

    window.__douyinFudaiCoreApi = api;
    window.__douyinFudaiCoreLoaded = true;
    setLogRemember('核心脚本已加载，等待入口启动');

    return api;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        installDouyinFudaiAutomation
    };
}

if (typeof window !== 'undefined') {
    window.installDouyinFudaiAutomation = installDouyinFudaiAutomation;
    window.__douyinFudaiCoreLoaded = true;
}

    function isRecommendPage() {
        if (!location.hostname.includes('douyin.com') || isLivePage()) {
            return false;
        }

        return location.href.includes('recommend=1') && getFeedItems().length > 0;
    }
