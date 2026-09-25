/**
 * 浏览器半的样式。
 *
 * ## 为什么自己插一段 `<style>` 而不是 import CSS
 *
 * 浏览器半是一个 `__ModuleLoader__` 工厂函数，**没有 CSS 产物的位置** ——
 * DSH 的模块表只解析 JS，第一方插件的 CSS 也是在工厂里插 `<style>` 的
 * （见 `@deepseek-ai/dsh-client-ui-goal/lib/client.js` 顶部）。
 * 这里的做法与之相同：用 `data-plugin-css` 打标，重复挂载不会插第二份。
 *
 * ## 为什么全部用 `--dsw-alias-*` 变量而不是写死颜色
 *
 * 这些是 DSH 主题的语义变量（第一方组件的取值来源）。写死颜色在深/浅色
 * 主题切换时会糊掉，而这个面板是**常驻**的 —— 一个在浅色主题下白底白字的
 * 常驻条会被当成 bug 报上来。
 *
 * ⚠️ 类名统一 `atr-` 前缀（ai-token-report）：样式是全局的，
 *   不加前缀迟早会撞上别的插件。
 */

/** `<style>` 标签的身份。同时用于去重与调试时定位来源。 */
import calendarCss from 'react-day-picker/style.css' with { type: 'text' }

export const STYLE_TAG_ID = '@ai-token-report/dsh-plugin/client.css'

export const CSS = calendarCss.replaceAll('.rdp-', '.atr-rdp-') + `
.atr-strip{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,748px);margin:0 auto;display:flex;align-items:center;gap:10px;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1));font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary)}
.atr-strip-label{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
.atr-strip-period{flex:none;color:var(--dsw-alias-label-tertiary)}
.atr-strip-metrics{min-width:0;flex:1;display:flex;align-items:baseline;gap:14px;overflow:hidden;white-space:nowrap}
.atr-strip-total{color:var(--dsw-alias-label-primary);font-weight:600}
.atr-strip-unit{color:var(--dsw-alias-label-tertiary);font-weight:400}
.atr-strip-sep{color:var(--dsw-alias-border-l4)}
.atr-strip-actions{flex:none;display:flex;align-items:center;gap:6px}
.atr-btn{border:0.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;border-radius:6px;padding:5px 9px;cursor:pointer;font-family:inherit;white-space:nowrap}
.atr-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.atr-btn[aria-pressed="true"]{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.atr-btn:disabled{opacity:.45;cursor:default}
.atr-warn{color:var(--dsw-alias-state-error-primary)}

.atr-card{margin-top:8px;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,748px);border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:12px;padding:12px 14px 10px;display:flex;flex-direction:column;gap:10px}
.atr-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.atr-title{font-weight:600;font-size:12.5px}
.atr-range{color:var(--dsw-alias-label-tertiary)}
.atr-grow{flex:1}
.atr-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap}

.atr-cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.atr-cell{border:0.5px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 9px;display:flex;flex-direction:column;gap:3px;background:var(--dsw-alias-bg-base)}
.atr-cell-k{color:var(--dsw-alias-label-tertiary);font-size:11px}
.atr-cell-v{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}
.atr-cell-v small{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}

.atr-metrics{display:flex;gap:16px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}
.atr-metrics b{color:var(--dsw-alias-label-primary);font-weight:600}
.atr-note{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px}

.atr-bars{display:flex;align-items:flex-end;gap:2px;height:38px}
.atr-bar{flex:1;min-width:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary);opacity:.75}
.atr-bar:hover{opacity:1}
.atr-axis{display:flex;justify-content:space-between;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:10.5px}

.atr-rows{display:flex;flex-direction:column;gap:2px}
.atr-pagination{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.atr-page-summary{margin-right:auto}
.atr-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:10px;align-items:baseline;padding:2px 0}
.atr-row-k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary-dimmed)}
.atr-row-n{text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.atr-row-n b{color:var(--dsw-alias-label-primary);font-weight:600}
.atr-empty{color:var(--dsw-alias-label-tertiary)}

.atr-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:8px}

.atr-badge{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;cursor:pointer;font-family:inherit;white-space:nowrap}
.atr-badge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.atr-badge-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary);flex:none}
.atr-badge-dot.atr-badge-dot-warn{background:var(--dsw-alias-state-error-primary)}

.atr-mask{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px}
.atr-dialog{box-sizing:border-box;width:min(1000px,100%);max-height:88vh;overflow:auto;border:0.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));box-shadow:0 16px 48px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.atr-dialog .atr-card{max-width:none;border:none;border-radius:0;background:transparent;margin-top:0}
.atr-card{max-height:70vh;overflow:auto;margin-left:auto;margin-right:auto;padding:20px;gap:18px}
.atr-dialog .atr-card{max-height:none;overflow:visible}
.atr-title{font-size:18px}.atr-cell{padding:14px;gap:9px}.atr-cell-v{font-size:24px}.atr-cell-k{font-size:12px}
.atr-section{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:18px}
.atr-bars{height:130px;gap:5px}.atr-bar{border-radius:4px 4px 0 0}
.atr-row{grid-template-columns:minmax(130px,1fr) 100px 75px 75px;padding:12px 6px;align-items:center}
.atr-row-detail{border-bottom:1px solid var(--dsw-alias-border-l1)}
.atr-row-detail summary{cursor:pointer}.atr-row-detail summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.atr-row-k:before{content:'▸ ';color:var(--dsw-alias-label-tertiary)}
.atr-row-detail[open] .atr-row-k:before{content:'▾ '}
.atr-breakdown{display:flex;flex-wrap:wrap;gap:12px;padding:4px 12px 16px;color:var(--dsw-alias-label-secondary)}
.atr-table-head{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.atr-table-head span:not(:first-child){text-align:right}.atr-close{display:block;margin:10px 12px 0 auto}
.atr-date-range{flex-basis:100%;display:flex;align-items:end;flex-wrap:wrap;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.atr-date-range label{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary)}
.atr-date-range input{padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.atr-settings{display:flex;flex-direction:column;gap:14px;line-height:1.6}.atr-form{display:grid;gap:16px}
.atr-field{display:flex;flex-direction:column;gap:6px}
.atr-field input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.atr-primary{padding:12px;border:1px solid var(--dsw-alias-border-l4)}
.atr-btn:focus-visible,.atr-row:focus-visible,.atr-field input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* 浮层使用宿主主题变量；卡片与日历共享语义色，深色模式下保持对比度。 */
.atr-dialog{--atr-accent:var(--dsw-alias-state-business-primary,#536de5);--atr-soft:color-mix(in srgb,var(--atr-accent) 9%,var(--dsw-alias-bg-base,#fff));--atr-chart-fill:color-mix(in srgb,var(--atr-accent) 12%,transparent);position:relative;width:min(1080px,100%);max-height:90vh;border-radius:20px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 24px 90px rgba(0,0,0,.2);font-family:inherit}
.atr-mask{background:rgba(20,28,45,.28);backdrop-filter:blur(4px);padding:28px}
.atr-dialog .atr-card{height:100%;min-height:0;padding:0;gap:0;overflow:hidden;line-height:1.5}
.atr-body{display:flex;flex-direction:column;gap:20px;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:20px 30px 30px}
.atr-dialog .atr-btn{padding:9px 13px;font-size:12px;line-height:1.2;border-radius:8px;transition:background .15s,color .15s}
.atr-dialog .atr-close{margin:0;width:34px;height:34px;padding:0;font-size:22px;color:var(--dsw-alias-label-tertiary)}
/* 标题与筛选不参与滚动，关闭和配置始终可达；仅正文承担滚动。 */
.atr-page-head{display:flex;flex:none;flex-direction:column;gap:22px;padding:24px 30px 0;position:relative;z-index:2;background:var(--dsw-alias-bg-base,#fff)}
.atr-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.atr-heading-actions{display:flex;align-items:center;gap:12px;flex:none}
.atr-eyebrow{display:block;font-size:11px;letter-spacing:2px;font-weight:600;color:var(--atr-accent);margin-bottom:5px}
.atr-title{margin:0 0 6px;font-size:23px;font-weight:650;letter-spacing:-.6px;line-height:1.4}
.atr-range{font-size:12px;color:var(--dsw-alias-label-secondary)}
.atr-filter-bar{position:relative;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.atr-segmented{gap:2px;padding:4px;border-radius:10px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1))}
.atr-segmented .atr-btn[aria-pressed="true"]{border-color:transparent;background:var(--dsw-alias-bg-base);color:var(--atr-accent);box-shadow:0 1px 4px rgba(0,0,0,.08);font-weight:600}
.atr-date-trigger{border:1px solid var(--dsw-alias-border-l2)}
.atr-filter-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
.atr-dialog .atr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:1px solid transparent;border-radius:9px;color:var(--dsw-alias-label-secondary)}
.atr-dialog .atr-icon-btn:hover:not(:disabled){background:var(--atr-soft);color:var(--atr-accent)}
.atr-icon-btn svg{flex:none}
.atr-refresh[aria-busy="true"] svg{animation:atr-refresh-spin 1s linear infinite}
@keyframes atr-refresh-spin{to{transform:rotate(360deg)}}
.atr-cells{gap:14px}
.atr-cell{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:13px;padding:20px;gap:9px;background:var(--dsw-alias-bg-base);overflow:hidden}
.atr-cell:first-child{background:var(--atr-soft);border-color:color-mix(in srgb,var(--atr-accent) 20%,transparent)}
.atr-cell:first-child .atr-cell-v{color:var(--atr-accent)}
.atr-cell-k{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.atr-cell-k:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--atr-accent);opacity:.8}
.atr-cell-v{font-size:30px;font-weight:650;letter-spacing:-.8px;line-height:1.15;font-variant-numeric:tabular-nums}
.atr-cell-unit{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.atr-metrics{gap:12px 24px;padding:0 2px;font-size:12px}
.atr-metrics b{margin-left:4px;font-variant-numeric:tabular-nums}
.atr-section{padding:20px;border-radius:14px;gap:16px;background:var(--dsw-alias-bg-base)}
.atr-section-title{display:block;font-size:14px;font-weight:600}
.atr-section-note{display:block;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.atr-chart{height:220px;position:relative;width:100%;min-width:0}
.atr-chart-empty{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary)}
.atr-dialog{height:min(940px,90vh);overflow:hidden}
.atr-chart-data{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.atr-chart-data summary{cursor:pointer;width:fit-content;padding:4px}
.atr-chart-table{max-height:220px;overflow:auto;margin-top:10px}
.atr-chart-table table{border-collapse:collapse;width:100%;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.atr-chart-table th,.atr-chart-table td{text-align:right;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:400}
.atr-chart-table th:first-child{text-align:left}
.atr-detail-section{gap:8px}
.atr-table-head{font-size:11px;margin-top:6px;padding:10px 12px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1));border:0;border-radius:7px}
.atr-row{grid-template-columns:minmax(130px,1fr) 110px 90px 80px;gap:12px;padding:13px 12px}
.atr-row-detail:last-child{border-bottom:0}
.atr-row-detail summary{border-radius:7px;list-style:none}
.atr-row-detail summary::-webkit-details-marker{display:none}
.atr-row-k{color:var(--dsw-alias-label-primary)}
.atr-row-n{font-size:12px}.atr-row-n:nth-child(2){font-weight:600;color:var(--dsw-alias-label-primary)}
.atr-breakdown{border-radius:8px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1));margin:0 10px 10px;padding:12px;font-size:11px}
.atr-foot{font-size:10px;gap:8px 16px;padding-top:14px}.atr-empty{padding:24px;text-align:center}
.atr-date-picker{position:static}
.atr-date-trigger{display:flex;align-items:center;gap:8px}
.atr-date-trigger[aria-pressed="true"],.atr-date-trigger[aria-expanded="true"]{color:var(--atr-accent);background:var(--atr-soft);border-color:color-mix(in srgb,var(--atr-accent) 30%,transparent)}
.atr-calendar-popover{box-sizing:border-box;position:absolute;left:0;top:calc(100% - 12px);z-index:5;width:630px;max-width:100%;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 16px 48px rgba(0,0,0,.15)}
.atr-calendar-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px}.atr-calendar-heading strong{font-size:14px}.atr-calendar-heading span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.atr-calendar-selection{display:flex;align-items:center;gap:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 16px;margin-bottom:16px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1))}
.atr-calendar-selection>div{display:flex;flex:1;flex-direction:column;gap:4px}.atr-calendar-selection span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.atr-calendar-selection strong{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.atr-calendar{--rdp-accent-color:var(--atr-accent);--rdp-accent-background-color:var(--atr-soft);--rdp-day-height:36px;--rdp-day-width:38px;--rdp-day_button-height:34px;--rdp-day_button-width:34px;--rdp-day_button-border-radius:8px;--rdp-months-gap:20px;--rdp-selected-border:0;--rdp-nav-height:36px;--rdp-nav_button-width:28px;--rdp-nav_button-height:28px}
.atr-calendar .atr-rdp-root{--rdp-accent-color:var(--atr-accent);--rdp-accent-background-color:var(--atr-soft);--rdp-day-height:36px;--rdp-day-width:38px;--rdp-day_button-height:34px;--rdp-day_button-width:34px;--rdp-day_button-border-radius:8px;--rdp-months-gap:20px;--rdp-selected-border:0;--rdp-nav-height:36px;--rdp-nav_button-width:28px;--rdp-nav_button-height:28px;font-size:12px}
.atr-calendar .atr-rdp-months{max-width:none;justify-content:space-between}.atr-calendar .atr-rdp-month_caption{font-size:13px;font-weight:600}.atr-calendar .atr-rdp-weekday{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.atr-calendar .atr-rdp-day_button:hover{background:var(--atr-soft)}
.atr-calendar .atr-rdp-selected{font-size:inherit;font-weight:600}
.atr-calendar .atr-rdp-range_start .atr-rdp-day_button,.atr-calendar .atr-rdp-range_end .atr-rdp-day_button{background:var(--atr-accent);color:#fff}
.atr-calendar .atr-rdp-dropdown{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.atr-calendar-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:16px;padding-top:16px}.atr-calendar-footer>span{color:var(--dsw-alias-label-tertiary);font-size:11px}.atr-calendar-footer>div{display:flex;gap:8px}
.atr-dialog .atr-primary{background:var(--atr-accent);border-color:var(--atr-accent);color:#fff}.atr-dialog .atr-primary:hover{filter:brightness(1.06)}
.atr-calendar button:focus-visible,.atr-date-trigger:focus-visible,.atr-chart-data summary:focus-visible{outline:2px solid var(--atr-accent);outline-offset:2px}
@media(max-width:700px){.atr-cells{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.atr-dialog .atr-card{padding:18px;gap:16px}.atr-mask{padding:8px}.atr-title{font-size:20px}.atr-row{grid-template-columns:minmax(70px,1fr) 65px 55px 58px;gap:6px;padding:12px 4px}.atr-cell{padding:16px}.atr-cell-v{font-size:24px}.atr-strip-metrics{gap:8px}.atr-strip-period{max-width:120px;overflow:hidden;text-overflow:ellipsis}.atr-section{padding:14px}.atr-chart{height:190px}.atr-filter-bar{gap:8px}.atr-filter-bar .atr-segmented{flex-basis:100%;justify-content:space-between}.atr-filter-bar .atr-segmented .atr-btn{padding:8px}.atr-calendar-popover{width:330px;padding:14px}.atr-calendar .atr-rdp-months{justify-content:center}.atr-calendar-footer{flex-wrap:wrap}.atr-calendar-footer>div{margin-left:auto}.atr-calendar-heading span{font-size:10px}}
@media(prefers-reduced-motion:reduce){.atr-dialog .atr-btn{transition:none}.atr-refresh[aria-busy="true"] svg{animation:none}}
@media(max-width:700px){.atr-dialog .atr-card{padding:0;gap:0}.atr-page-head{padding:18px 18px 0;gap:16px}.atr-body{padding:16px 18px 18px;gap:16px}.atr-heading-actions{gap:6px}}
@media(max-height:760px){.atr-calendar-popover{max-height:calc(90vh - 220px);overflow:auto;overscroll-behavior:contain}}

`

/**
 * 幂等地插入样式，返回卸载用的清理函数。
 *
 * 幂等的判据是 `data-plugin-css`（而不是模块级变量）：DSH 的 HMR 会**重新
 * 执行**工厂函数，模块级变量归零但页面上的 `<style>` 还在 ——
 * 只看变量就会越插越多。
 */
export function installStyles(doc: Document | undefined = globalThis.document): () => void {
  if (doc === undefined) return () => {}

  const existing = doc.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null) return () => {}

  const tag = doc.createElement('style')
  tag.dataset['plugin'] = '@ai-token-report/dsh-plugin'
  tag.dataset['pluginCss'] = STYLE_TAG_ID
  tag.textContent = CSS
  doc.head.appendChild(tag)

  return () => {
    tag.remove()
  }
}
