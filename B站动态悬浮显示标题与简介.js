// ==UserScript==
// @name         B站动态悬浮显示标题与简介
// @namespace    https://github.com/habixz
// @version      1.0.0
// @description  在 B 站动态页悬浮显示视频卡片标题与简介全文，并自动适配深浅色主题
// @author       habixz
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/v/topic/detail/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'B站动态悬浮显示标题与简介';
    const STYLE_ID = 'bili-dynamic-hover-tooltip-style';
    const CARD_SELECTOR = '.bili-dyn-item';
    const TOOLTIP_TARGET_RULES = [
        // 新版链接卡片标题。
        { selector: '.bili-dyn-card-link-common__detail__title', type: 'title' },
        // 新版链接卡片简介。
        { selector: '.bili-dyn-card-link-common__detail__desc', type: 'desc' },
        // 不直接匹配通用的 .dyn-card-opus__summary，避免普通图文正文也触发提示。
        // 这里只保留明确属于视频/链接卡片的标题和简介节点。
        { selector: '.bili-dyn-card-video__title', type: 'title' },
        { selector: '.bili-dyn-card-video__desc', type: 'desc' }
    ];
    const DEFAULT_SURFACE = 'rgba(255, 255, 255, 0.96)';
    const DEFAULT_TEXT = '#18191c';
    const TOOLTIP_DELAY = 100;
    const TOOLTIP_OFFSET = 14;

    const state = {
        mounted: false,
        tooltipTimerId: 0,
        tooltipPositionFrameId: 0,
        tooltipTarget: null,
        tooltipTargetType: null,
        tooltipHorizontalSide: 'right',
        pointerPosition: null,
        tooltipElement: null,
        tooltipMetrics: null,
        themeObserver: null,
        historyHooked: false,
        eventsBound: false,
        pointerTrackingBound: false
    };

    bootstrap();

    /**
     * 脚本入口。
     * Tooltip 使用事件委托，所以只要把全局监听和样式挂好，
     * 后续动态流继续加载的新节点也能自动生效。
     */
    function bootstrap() {
        hookHistoryMethods();
        window.addEventListener('popstate', handleRouteChanged, { passive: true });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mount, { once: true });
        } else {
            mount();
        }
    }

    /**
     * 只执行一次正式挂载。
     */
    function mount() {
        if (state.mounted || !document.body) {
            return;
        }

        ensureStyle();
        bindGlobalEvents();
        startObservers();
        refreshThemeTokens();
        state.mounted = true;
    }

    /**
     * 注入 Tooltip 样式。
     * 标题和简介共用一套基础外观，但标题额外保持单行不换行。
     */
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            :root {
                --bdht-surface: ${DEFAULT_SURFACE};
                --bdht-text: ${DEFAULT_TEXT};
                --bdht-border: rgba(24, 25, 28, 0.10);
                --bdht-shadow: rgba(24, 25, 28, 0.14);
            }
            @media (prefers-color-scheme: dark) {
                :root {
                    --bdht-surface: rgba(31, 34, 39, 0.94);
                    --bdht-text: #f1f2f3;
                    --bdht-border: rgba(255, 255, 255, 0.10);
                    --bdht-shadow: rgba(0, 0, 0, 0.32);
                }
            }
            .bdht-smart-tooltip {
                position: fixed;
                left: 0;
                top: 0;
                z-index: 2147483647;
                pointer-events: none;
                box-sizing: border-box;
                width: max-content;
                overflow: auto;
                padding: 10px 12px;
                border: 1px solid var(--bdht-border);
                border-radius: 12px;
                background: var(--bdht-surface);
                color: var(--bdht-text);
                box-shadow: 0 16px 36px var(--bdht-shadow);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                white-space: pre;
                word-break: normal;
                overflow-wrap: normal;
                line-height: 1.6;
                font-size: 14px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                scrollbar-width: thin;
            }
            .bdht-smart-tooltip--title {
                white-space: nowrap;
                word-break: normal;
                overflow-wrap: normal;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 绑定 Tooltip 所需的全局事件。
     * 这里使用事件委托，避免给每条动态里的标题/简介都单独绑监听器。
     */
    function bindGlobalEvents() {
        if (state.eventsBound) {
            return;
        }

        document.addEventListener('mouseover', handlePointerOver, true);
        document.addEventListener('mouseout', handlePointerOut, true);
        window.addEventListener('scroll', handleViewportChanged, true);
        window.addEventListener('resize', handleViewportChanged, { passive: true });
        window.addEventListener('blur', clearTooltipImmediately);
        state.eventsBound = true;
    }

    /**
     * 只有在存在活跃 hover 目标时才监听鼠标移动，
     * 避免脚本在整个页面生命周期里常驻接收全局 mousemove。
     */
    function ensurePointerTracking() {
        if (state.pointerTrackingBound) {
            return;
        }

        document.addEventListener('mousemove', handlePointerMove, true);
        state.pointerTrackingBound = true;
    }

    /**
     * 当前没有 hover 目标后，及时移除高频 mousemove 监听。
     */
    function releasePointerTracking() {
        if (!state.pointerTrackingBound) {
            return;
        }

        document.removeEventListener('mousemove', handlePointerMove, true);
        state.pointerTrackingBound = false;
    }

    /**
     * 使用 requestAnimationFrame 合并同一帧内的多次定位请求，
     * 避免鼠标快速移动时反复同步读写布局。
     */
    function requestTooltipPositionUpdate() {
        if (!state.tooltipElement || state.tooltipPositionFrameId) {
            return;
        }

        state.tooltipPositionFrameId = window.requestAnimationFrame(() => {
            state.tooltipPositionFrameId = 0;
            updateTooltipPosition();
        });
    }

    /**
     * 清掉尚未执行的定位刷新，避免 Tooltip 已销毁后还有残留帧回调。
     */
    function cancelTooltipPositionUpdate() {
        if (!state.tooltipPositionFrameId) {
            return;
        }

        window.cancelAnimationFrame(state.tooltipPositionFrameId);
        state.tooltipPositionFrameId = 0;
    }

    /**
     * 监听主题切换。
     * Tooltip 的配色直接跟着页面主题变量走，避免深色模式下出现发白。
     */
    function startObservers() {
        if (state.themeObserver) {
            return;
        }

        state.themeObserver = new MutationObserver(() => {
            refreshThemeTokens();
        });

        state.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
        });

        state.themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    }

    /**
     * 鼠标进入命中的标题/简介节点时，启动延时显示逻辑。
     * @param {MouseEvent} event
     */
    function handlePointerOver(event) {
        const target = getTooltipTarget(event.target);
        if (!target) {
            return;
        }

        const fromTarget = getTooltipTarget(event.relatedTarget);
        if (fromTarget === target) {
            return;
        }

        scheduleTooltipForTarget(target, event);
    }

    /**
     * 鼠标离开当前目标时，立即清除提示框和延时器。
     * @param {MouseEvent} event
     */
    function handlePointerOut(event) {
        const target = getTooltipTarget(event.target);
        if (!target || target !== state.tooltipTarget) {
            return;
        }

        const nextTarget = getTooltipTarget(event.relatedTarget);
        if (nextTarget === target) {
            return;
        }

        clearTooltipImmediately();
    }

    /**
     * 鼠标在当前目标内移动时，持续记录坐标并更新 Tooltip 位置。
     * @param {MouseEvent} event
     */
    function handlePointerMove(event) {
        if (!state.tooltipTarget) {
            return;
        }

        if (!(event.target instanceof Node) || !state.tooltipTarget.contains(event.target)) {
            return;
        }

        state.pointerPosition = snapshotPointer(event);

        if (state.tooltipElement) {
            requestTooltipPositionUpdate();
        }
    }

    /**
     * 视口变化后直接移除 Tooltip，避免固定定位的提示框滞留在旧位置。
     */
    function handleViewportChanged() {
        clearTooltipImmediately();
    }

    /**
     * SPA 路由切换后顺手关闭当前 Tooltip，并刷新一次主题变量。
     */
    function handleRouteChanged() {
        clearTooltipImmediately();
        refreshThemeTokens();
    }

    /**
     * 为当前 hover 目标启动延时显示逻辑。
     * @param {HTMLElement} target
     * @param {MouseEvent} event
     */
    function scheduleTooltipForTarget(target, event) {
        window.clearTimeout(state.tooltipTimerId);
        removeTooltipElement();

        state.tooltipTarget = target;
        state.pointerPosition = snapshotPointer(event);
        state.tooltipTargetType = getTooltipTargetType(target);
        state.tooltipHorizontalSide = 'right';
        ensurePointerTracking();
        state.tooltipTimerId = window.setTimeout(() => {
            state.tooltipTimerId = 0;
            showTooltipIfNeeded();
        }, TOOLTIP_DELAY);
    }

    /**
     * 真正显示 Tooltip 之前执行一次条件检查。
     * 当前策略是：只要命中目标且文本非空，就直接显示完整内容。
     */
    function showTooltipIfNeeded() {
        const target = state.tooltipTarget;
        if (!(target instanceof HTMLElement) || !document.contains(target)) {
            clearTooltipImmediately();
            return;
        }

        const text = getTooltipText(target);
        if (!text) {
            clearTooltipImmediately();
            return;
        }

        createTooltipElement(text, state.tooltipTargetType || 'desc');
        updateTooltipPosition();
    }

    /**
     * 创建 Tooltip DOM。
     * 标题和简介会分别打上不同 class，以便控制换行策略。
     * @param {string} text
     * @param {'title' | 'desc'} type
     */
    function createTooltipElement(text, type) {
        removeTooltipElement();

        const tooltip = document.createElement('div');
        tooltip.className = `bdht-smart-tooltip ${type === 'title' ? 'bdht-smart-tooltip--title' : 'bdht-smart-tooltip--desc'}`;
        tooltip.textContent = text;
        document.body.appendChild(tooltip);
        state.tooltipElement = tooltip;
        const rect = tooltip.getBoundingClientRect();
        state.tooltipMetrics = {
            width: rect.width,
            height: rect.height
        };
    }

    /**
     * 更新 Tooltip 在视口内的位置。
     * 水平方向采用“带状态”的左右停靠策略，避免鼠标临界位置左右来回横跳。
     */
    function updateTooltipPosition() {
        if (!state.tooltipElement || !state.pointerPosition) {
            return;
        }

        const tooltip = state.tooltipElement;
        const pointer = state.pointerPosition;
        const margin = 12;

        let left = pointer.clientX + TOOLTIP_OFFSET;
        let top = pointer.clientY + TOOLTIP_OFFSET;

        const metrics = state.tooltipMetrics || tooltip.getBoundingClientRect();
        const tooltipWidth = metrics.width;
        const tooltipHeight = metrics.height;
        const rightSideLeft = pointer.clientX + TOOLTIP_OFFSET;
        const leftSideLeft = pointer.clientX - tooltipWidth - TOOLTIP_OFFSET;
        const rightSideOverflow = rightSideLeft + tooltipWidth > window.innerWidth - margin;
        const leftSideOverflow = leftSideLeft < margin;

        if (state.tooltipHorizontalSide === 'left') {
            if (leftSideOverflow && !rightSideOverflow) {
                state.tooltipHorizontalSide = 'right';
            }
        } else if (rightSideOverflow && !leftSideOverflow) {
            state.tooltipHorizontalSide = 'left';
        }

        if (state.tooltipHorizontalSide === 'left') {
            left = Math.max(margin, leftSideLeft);
        } else {
            left = Math.min(rightSideLeft, window.innerWidth - margin - tooltipWidth);
        }

        if (top + tooltipHeight > window.innerHeight - margin) {
            top = Math.max(margin, pointer.clientY - tooltipHeight - TOOLTIP_OFFSET);
        }

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
    }

    /**
     * 立即清除当前 Tooltip 与延时器。
     * 这是统一的悬停状态重置入口。
     */
    function clearTooltipImmediately() {
        window.clearTimeout(state.tooltipTimerId);
        state.tooltipTimerId = 0;
        cancelTooltipPositionUpdate();
        state.tooltipTarget = null;
        state.tooltipTargetType = null;
        state.tooltipHorizontalSide = 'right';
        state.pointerPosition = null;
        releasePointerTracking();
        removeTooltipElement();
    }

    /**
     * 删除当前 Tooltip DOM。
     */
    function removeTooltipElement() {
        cancelTooltipPositionUpdate();
        if (state.tooltipElement) {
            state.tooltipElement.remove();
            state.tooltipElement = null;
        }

        state.tooltipMetrics = null;
    }

    /**
     * 获取事件对应的 Tooltip 目标元素。
     * 只识别视频/链接卡片的标题与简介节点。
     * @param {EventTarget | null} target
     * @returns {HTMLElement | null}
     */
    function getTooltipTarget(target) {
        if (!(target instanceof Element)) {
            return null;
        }

        for (const rule of TOOLTIP_TARGET_RULES) {
            const matchedTarget = target.closest(rule.selector);
            if (matchedTarget instanceof HTMLElement) {
                return matchedTarget;
            }
        }

        return null;
    }

    /**
     * 区分当前目标属于标题还是简介。
     * 标题 Tooltip 固定单行；简介 Tooltip 保留原始换行。
     * @param {HTMLElement} target
     * @returns {'title' | 'desc'}
     */
    function getTooltipTargetType(target) {
        for (const rule of TOOLTIP_TARGET_RULES) {
            if (target.matches(rule.selector)) {
                return rule.type;
            }
        }

        return 'desc';
    }

    /**
     * 读取 Tooltip 要显示的文本，并按类型做统一清理。
     * @param {HTMLElement} target
     * @returns {string}
     */
    function getTooltipText(target) {
        return normalizeTooltipText(target.textContent || '', getTooltipTargetType(target));
    }

    /**
     * 刷新 Tooltip 使用的主题色变量。
     * 优先读 B 站自己的 CSS 变量，读不到时退回页面真实计算色。
     */
    function refreshThemeTokens() {
        if (!document.body) {
            return;
        }

        const rootStyle = window.getComputedStyle(document.documentElement);
        const bodyStyle = window.getComputedStyle(document.body);
        const sampleCard = document.querySelector(CARD_SELECTOR);
        const sampleStyle = sampleCard instanceof HTMLElement
            ? window.getComputedStyle(sampleCard)
            : bodyStyle;

        const surface = pickFirstVisibleColor(
            rootStyle.getPropertyValue('--bg1'),
            rootStyle.getPropertyValue('--bg2'),
            rootStyle.getPropertyValue('--background-color'),
            sampleStyle.backgroundColor,
            bodyStyle.backgroundColor,
            DEFAULT_SURFACE
        );
        const text = pickFirstVisibleColor(
            rootStyle.getPropertyValue('--text1'),
            rootStyle.getPropertyValue('--text2'),
            sampleStyle.color,
            bodyStyle.color,
            DEFAULT_TEXT
        );
        const border = pickFirstVisibleColor(
            rootStyle.getPropertyValue('--line_regular'),
            rootStyle.getPropertyValue('--line_light'),
            withAlpha(text, isDarkColor(surface) ? 0.16 : 0.10)
        );
        const shadow = isDarkColor(surface)
            ? 'rgba(0, 0, 0, 0.32)'
            : 'rgba(24, 25, 28, 0.14)';

        document.documentElement.style.setProperty('--bdht-surface', surface);
        document.documentElement.style.setProperty('--bdht-text', text);
        document.documentElement.style.setProperty('--bdht-border', border);
        document.documentElement.style.setProperty('--bdht-shadow', shadow);
    }

    /**
     * 接管 history.pushState / replaceState。
     * 这样 B 站 SPA 路由切换后，Tooltip 状态也能及时重置。
     */
    function hookHistoryMethods() {
        if (state.historyHooked) {
            return;
        }

        const methods = ['pushState', 'replaceState'];
        methods.forEach(methodName => {
            const originalMethod = history[methodName];
            history[methodName] = function (...args) {
                const result = originalMethod.apply(this, args);
                handleRouteChanged();
                return result;
            };
        });

        state.historyHooked = true;
    }

    /**
     * 记录鼠标当前位置，只保留 Tooltip 真正需要的两个坐标。
     * @param {MouseEvent} event
     * @returns {{ clientX: number, clientY: number }}
     */
    function snapshotPointer(event) {
        return {
            clientX: event.clientX,
            clientY: event.clientY
        };
    }

    /**
     * 规范化 Tooltip 文本。
     * - 保留真实换行
     * - 清掉行尾多余空白
     * - 把连续 3 个以上空行压缩为 2 个
     * 标题会额外折叠为单行，避免 Tooltip 自己再换行。
     * @param {string} text
     * @param {'title' | 'desc'} type
     * @returns {string}
     */
    function normalizeTooltipText(text, type) {
        const normalized = String(text || '')
            .replace(/\r/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        if (type === 'title') {
            return normalized.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        return normalized;
    }

    /**
     * 从一组候选颜色里，挑出第一个有效且非透明的颜色字符串。
     * @param {...string} colors
     * @returns {string}
     */
    function pickFirstVisibleColor(...colors) {
        for (const color of colors) {
            const normalized = String(color || '').trim();
            if (!normalized || isTransparentColor(normalized)) {
                continue;
            }

            return normalized;
        }

        return '#ffffff';
    }

    /**
     * 判断一个颜色值是否等同于透明。
     * @param {string} color
     * @returns {boolean}
     */
    function isTransparentColor(color) {
        const normalized = color.replace(/\s+/g, '').toLowerCase();
        return (
            normalized === 'transparent' ||
            normalized === 'rgba(0,0,0,0)' ||
            normalized === 'hsla(0,0%,0%,0)'
        );
    }

    /**
     * 给颜色套上一层新的透明度。
     * 当前支持 rgb/rgba/hex 三类常见颜色写法。
     * @param {string} color
     * @param {number} alpha
     * @returns {string}
     */
    function withAlpha(color, alpha) {
        const parsed = parseColor(color);
        if (!parsed) {
            return color;
        }

        return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
    }

    /**
     * 判断颜色整体更偏亮还是更偏暗。
     * 这里只用于决定边框与阴影回退值。
     * @param {string} color
     * @returns {boolean}
     */
    function isDarkColor(color) {
        const parsed = parseColor(color);
        if (!parsed) {
            return false;
        }

        const luminance = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
        return luminance < 0.55;
    }

    /**
     * 解析常见 CSS 颜色格式。
     * @param {string} color
     * @returns {{ r: number, g: number, b: number } | null}
     */
    function parseColor(color) {
        const normalized = String(color || '').trim();

        const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
        if (rgbMatch) {
            const parts = rgbMatch[1]
                .split(',')
                .slice(0, 3)
                .map(part => Number.parseFloat(part.trim()));

            if (parts.length === 3 && parts.every(Number.isFinite)) {
                return {
                    r: clampColorChannel(parts[0]),
                    g: clampColorChannel(parts[1]),
                    b: clampColorChannel(parts[2])
                };
            }
        }

        const hexMatch = normalized.match(/^#([0-9a-f]{3,8})$/i);
        if (!hexMatch) {
            return null;
        }

        let hex = hexMatch[1];
        if (hex.length === 3 || hex.length === 4) {
            hex = hex.split('').map(char => char + char).join('');
        }

        if (hex.length !== 6 && hex.length !== 8) {
            return null;
        }

        return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16)
        };
    }

    /**
     * 约束颜色通道值范围，避免异常输入污染结果。
     * @param {number} value
     * @returns {number}
     */
    function clampColorChannel(value) {
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    console.info(`[${SCRIPT_NAME}] 已启动`);
})();
