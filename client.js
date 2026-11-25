/**
 * RSI overview — Client half.
 *
 * Registers one sidebar entry plus the matching main panel. Both are read-only:
 * the panel fetches a JSON snapshot from this plugin's own Host route and never
 * calls a mutating tool, so approving, adopting and re-running stay in the
 * conversation with the `rsi-*` tools.
 *
 * No Harness Client package is required here; only `react` and the `slots`
 * service. Styles are inline or scoped to this component's own subtree, and
 * every registration is an effect of `ctx.slots.inject`, so unloading the
 * plugin removes exactly the entry and the panel.
 */
(function () {
  'use strict';

  var LOADER = typeof window !== 'undefined' ? window.__ModuleLoader__ : null;
  if (!LOADER || typeof LOADER.load !== 'function') return;

  LOADER.load({
    id: 'dsh-rsi',
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useRef = React.useRef;
      var useMemo = React.useMemo;

      var PANEL_ID = 'rsi-overview';
      /* The apply context is Node-free, so the panel reaches services through
       * this closure instead of a prop the slot shell does not pass. */
      var shared = { ctx: null, boot: null, active: { sessionId: null, cwd: '' } };
      var API_PATH = '/rsi-overview/api/overview';
      var SYNC_PATH = '/rsi-overview/api/sync';
      var MAX_HINTS = 32;
      var PANEL_ORDER = 1;

      /* ---------------------------------------------------------------- text */

      var STRINGS = {
        zh: {
          entryLabel: 'RSI 总览',
          title: 'RSI 实验总览',
          subtitle: '跨所有工作区聚合的只读 .rsi 实验记录',
          refresh: '刷新',
          refreshing: '读取中…',
          workspace: '工作区',
          allWorkspaces: '全部工作区',
          filterWorkspace: '筛选工作区',
          workspaceUnit: '个工作区',
          statRuns: '实验数',
          statPassRate: '最近 collect 通过率',
          statProposals: '待审提案',
          statEvidence: '失败证据',
          statLessons: '采纳教训',
          runsUnit: '个实验',
          runsActive: '运行中',
          runsArchived: '已归档',
          noCollect: '尚未 collect',
          libraryMissing: '未创建提案库',
          evidenceFiles: '个证据文件',
          lessonBlocks: '条教训',
          tabRuns: '实验',
          tabProposals: '提案',
          tabEvidence: '证据',
          tabLessons: '教训',
          tabLedger: '账本',
          ledgerHint: '跨工作区汇总的教训与提案；批准、采纳仍回对话用 rsi-* 工具。',
          syncLedger: '同步账本',
          syncing: '同步中…',
          ledgerNever: '尚未同步',
          ledgerUpdated: '更新于',
          ledgerEmpty: '全局账本还没有条目。点「同步账本」把各工作区的教训汇总进来。',
          ledgerSources: '个来源',
          ledgerLesson: '教训',
          ledgerProposal: '提案',
          syncAdded: '同步完成',
          syncFailed: '同步失败',
          syncNothing: '没有新条目',
          emptyTitle: '还没有 RSI 记录',
          emptyDetail: '当前工作区没有 .rsi 目录。先用 rsi 技能或 rsi-* 工具做一轮实验，再刷新这里。',
          emptyGlobalTitle: '还没有可聚合的 RSI 记录',
          emptyGlobalDetail: '已注册工作区里都没有 .rsi 目录。先在一个工作区跑一轮实验，再刷新这里。',
          emptyNoWorkspace: '尚未确定工作区',
          emptyNoWorkspaceDetail: '无法从界面推断当前工作区路径。在对话里打开一个工作区后再刷新。',
          triedPaths: '已尝试的路径',
          loadFailed: '读取失败',
          retry: '重试',
          listEmpty: '暂无记录',
          listEmptyRuns: '还没有实验目录（.rsi/runs）。',
          listEmptyProposals: '提案库为空。批准、采纳请回对话用 rsi-review / rsi-adopt。',
          listEmptyEvidence: '没有采集到失败证据。',
          listEmptyLessons: '沉淀区还没有教训条目。',
          detailPlaceholder: '从左侧选一条记录查看详情。',
          statusPassed: '通过',
          statusFailed: '未通过',
          statusUnscored: '待评分',
          statusPlanned: '计划中',
          statusArchived: '已归档',
          pending: '待审',
          approved: '已批准',
          rejected: '已驳回',
          applied: '已采纳',
          unknown: '未知',
          variants: '变体',
          repeats: '重复',
          passRate: '通过率',
          score: '均分',
          rubric: '评分表校验',
          rubricOk: '已校验',
          rubricUnverified: '未校验',
          created: '创建',
          updated: '更新',
          parent: '父代实验',
          archivedAt: '归档时间',
          reportTitle: 'collect 报告',
          checklist: '评分项',
          hypothesis: '改进假设',
          evidenceRef: '依据证据',
          changes: '拟改动',
          body: '正文',
          toolLabel: '工具',
          sourceLabel: '来源',
          fileLabel: '文件',
          timeLabel: '时间',
          argsLabel: '参数',
          truncated: '仅显示最近一部分记录',
          reachedFiles: '证据目录里的文件较多，仅统计最近的若干文件。',
          yes: '是',
          no: '否',
          variantsPassed: '通过变体',
        },
        en: {
          entryLabel: 'RSI overview',
          title: 'RSI experiment overview',
          subtitle: 'Read-only .rsi records aggregated across every workspace',
          refresh: 'Refresh',
          refreshing: 'Reading…',
          workspace: 'Workspace',
          allWorkspaces: 'All workspaces',
          filterWorkspace: 'Filter workspace',
          workspaceUnit: 'workspaces',
          statRuns: 'Experiments',
          statPassRate: 'Latest collect pass rate',
          statProposals: 'Proposals awaiting review',
          statEvidence: 'Failure evidence',
          statLessons: 'Adopted lessons',
          runsUnit: 'experiments',
          runsActive: 'live',
          runsArchived: 'archived',
          noCollect: 'no collect yet',
          libraryMissing: 'proposal library not created',
          evidenceFiles: 'evidence files',
          lessonBlocks: 'lessons',
          tabRuns: 'Experiments',
          tabProposals: 'Proposals',
          tabEvidence: 'Evidence',
          tabLessons: 'Lessons',
          tabLedger: 'Ledger',
          ledgerHint: 'Lessons and proposals aggregated across workspaces; approve/adopt still happens in the conversation with rsi-* tools.',
          syncLedger: 'Sync ledger',
          syncing: 'Syncing…',
          ledgerNever: 'never synced',
          ledgerUpdated: 'Updated',
          ledgerEmpty: 'The global ledger is empty. Use "Sync ledger" to collect lessons from every workspace.',
          ledgerSources: 'sources',
          ledgerLesson: 'lesson',
          ledgerProposal: 'proposal',
          syncAdded: 'Sync complete',
          syncFailed: 'Sync failed',
          syncNothing: 'No new entries',
          emptyTitle: 'No RSI records yet',
          emptyDetail: 'This workspace has no .rsi directory. Run one round with the rsi skill or the rsi-* tools, then refresh here.',
          emptyGlobalTitle: 'No RSI records to aggregate yet',
          emptyGlobalDetail: 'None of the registered workspaces has a .rsi directory. Run one round in a workspace, then refresh here.',
          emptyNoWorkspace: 'No workspace resolved',
          emptyNoWorkspaceDetail: 'The current workspace path could not be derived from the interface. Open a workspace in the conversation and refresh.',
          triedPaths: 'Paths tried',
          loadFailed: 'Read failed',
          retry: 'Retry',
          listEmpty: 'No records',
          listEmptyRuns: 'No run directories under .rsi/runs yet.',
          listEmptyProposals: 'The proposal library is empty. Approve or adopt in the conversation with rsi-review / rsi-adopt.',
          listEmptyEvidence: 'No failure evidence has been collected.',
          listEmptyLessons: 'No lessons recorded yet.',
          detailPlaceholder: 'Select a record on the left to see details.',
          statusPassed: 'passed',
          statusFailed: 'failed',
          statusUnscored: 'unscored',
          statusPlanned: 'planned',
          statusArchived: 'archived',
          pending: 'pending',
          approved: 'approved',
          rejected: 'rejected',
          applied: 'applied',
          unknown: 'unknown',
          variants: 'Variants',
          repeats: 'Repeats',
          passRate: 'Pass rate',
          score: 'Score',
          rubric: 'Rubric check',
          rubricOk: 'verified',
          rubricUnverified: 'unverified',
          created: 'Created',
          updated: 'Updated',
          parent: 'Parent run',
          archivedAt: 'Archived',
          reportTitle: 'Collect report',
          checklist: 'Rubric items',
          hypothesis: 'Hypothesis',
          evidenceRef: 'Evidence',
          changes: 'Planned changes',
          body: 'Body',
          toolLabel: 'Tool',
          sourceLabel: 'Source',
          fileLabel: 'File',
          timeLabel: 'Time',
          argsLabel: 'Args',
          truncated: 'Only the most recent records are shown',
          reachedFiles: 'The evidence directory holds many files; only the most recent ones are counted.',
          yes: 'yes',
          no: 'no',
          variantsPassed: 'variants passed',
        },
      };

      function detectLanguage() {
        try {
          var fromDocument = document.documentElement && document.documentElement.getAttribute('lang');
          if (fromDocument) return String(fromDocument).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
        } catch (error) {
          /* fall through to the browser language */
        }
        try {
          var language = String(navigator.language || '').toLowerCase();
          return language.indexOf('zh') === 0 ? 'zh' : 'en';
        } catch (error) {
          return 'zh';
        }
      }

      var LANGUAGE = detectLanguage();
      var DICT = STRINGS[LANGUAGE] || STRINGS.zh;

      function t(key) {
        var value = DICT[key];
        if (typeof value === 'string') return value;
        var fallback = STRINGS.zh[key];
        return typeof fallback === 'string' ? fallback : key;
      }

      /* --------------------------------------------------------------- utils */

      var WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
      var UNC_PATH = /^\\\\[^\\]/;
      var POSIX_PATH = /^\/(?:home|Users|workspace|workspaces|mnt|opt|root|srv|var|tmp|Volumes)\//;

      function looksLikePath(value) {
        if (typeof value !== 'string') return false;
        var text = value.trim();
        if (text.length < 4 || text.length > 380) return false;
        return WINDOWS_PATH.test(text) || UNC_PATH.test(text) || POSIX_PATH.test(text);
      }

      /** Clip with a trailing ellipsis; non-strings become "". */
      function clip(value, max) {
        var text = typeof value === 'string' ? value : '';
        return text.length > max ? text.slice(0, max - 1) + '…' : text;
      }

      /** Percentage from a 0..1 ratio, or a dash. */
      function percent(ratio) {
        if (typeof ratio !== 'number' || !isFinite(ratio)) return '—';
        var value = Math.max(0, Math.min(1, ratio)) * 100;
        return (Math.round(value * 10) / 10) + '%';
      }

      /** A local clock label from an ISO string. */
      function clock(iso) {
        if (typeof iso !== 'string' || !iso) return '';
        var parsed = new Date(iso);
        if (isNaN(parsed.getTime())) return iso;
        try {
          return parsed.toLocaleString(LANGUAGE === 'zh' ? 'zh-CN' : 'en-US', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch (error) {
          return parsed.toISOString();
        }
      }

      function basename(value) {
        if (typeof value !== 'string' || !value) return '';
        var parts = value.split(/[\\/]/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : value;
      }

      /**
       * Derive workspace path hints from values the page already holds.
       *
       * Hints are not authority: the Host validates every candidate on disk and
       * walks up until it finds `.rsi`. Reading them keeps this Client free of
       * Host-only services and of any DOM inspection.
       */
      function collectPathHints(sources) {
        var hints = [];
        var seen = {};
        var visited = typeof WeakSet === 'function' ? new WeakSet() : null;
        var budget = 600;

        function push(value) {
          if (!looksLikePath(value)) return;
          var path = value.trim().replace(/[\\/]+$/, '');
          if (!path || seen[path]) return;
          if (hints.length >= MAX_HINTS) return;
          seen[path] = true;
          hints.push(path);
        }

        function walk(value, depth) {
          if (budget <= 0 || depth > 5 || value === null || value === undefined) return;
          budget -= 1;
          if (typeof value === 'string') {
            push(value);
            return;
          }
          if (typeof value !== 'object') return;
          if (value.nodeType || value.$$typeof) return;
          if (visited) {
            if (visited.has(value)) return;
            visited.add(value);
          }
          if (Array.isArray(value)) {
            for (var index = 0; index < value.length && index < 40; index += 1) walk(value[index], depth + 1);
            return;
          }
          var keys;
          try {
            keys = Object.keys(value);
          } catch (error) {
            return;
          }
          for (var keyIndex = 0; keyIndex < keys.length && keyIndex < 60; keyIndex += 1) {
            var key = keys[keyIndex];
            var item;
            try {
              item = value[key];
            } catch (error) {
              continue;
            }
            if (typeof item === 'function') continue;
            walk(item, depth + 1);
          }
        }

        for (var index = 0; index < sources.length; index += 1) walk(sources[index], 0);

        try {
          var href = String(window.location.href || '');
          var queryIndex = href.indexOf('?');
          if (queryIndex >= 0) {
            var query = href.slice(queryIndex + 1);
            var pairs = query.split('&');
            for (var pairIndex = 0; pairIndex < pairs.length && pairIndex < 20; pairIndex += 1) {
              var equals = pairs[pairIndex].indexOf('=');
              if (equals < 0) continue;
              try {
                push(decodeURIComponent(pairs[pairIndex].slice(equals + 1)));
              } catch (error) {
                /* an undecodable value is not a path */
              }
            }
          }
        } catch (error) {
          /* no location: hints stay whatever the services provided */
        }

        return hints;
      }

      /** Snapshot-like values a service exposes without side effects. */
      function serviceSnapshots(service) {
        var out = [];
        if (!service || typeof service !== 'object') return out;
        var readers = ['getSnapshot', 'snapshot', 'getState', 'state', 'current', 'getCurrent', 'list', 'all', 'values'];
        for (var index = 0; index < readers.length; index += 1) {
          var reader = readers[index];
          var member;
          try {
            member = service[reader];
          } catch (error) {
            continue;
          }
          if (typeof member === 'function') {
            try {
              var value = member.call(service);
              if (value !== undefined && value !== null) out.push(value);
            } catch (error) {
              /* a reader that requires arguments is simply skipped */
            }
          } else if (member !== undefined && member !== null) {
            out.push(member);
          }
        }
        return out;
      }

      /** Every registered workspace path, from the Client's `workspaces` service. */
      function allWorkspacePaths(ctx) {
        var out = [];
        var seen = {};
        function push(value) {
          if (typeof value !== 'string') return;
          var path = value.trim().replace(/[\\/]+$/, '');
          if (!path || seen[path]) return;
          seen[path] = true;
          out.push(path);
        }
        try {
          var service = ctx && typeof ctx.get === 'function' ? ctx.get('workspaces') : null;
          var source = service && service.list;
          var snapshot = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : source;
          var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : Array.isArray(snapshot) ? snapshot : [];
          for (var index = 0; index < items.length; index += 1) {
            var item = items[index];
            if (!item || typeof item !== 'object') continue;
            push(item.path);
            push(item.directory);
            push(item.cwd);
            if (item.workspace && typeof item.workspace === 'object') push(item.workspace.path);
          }
        } catch (error) {
          /* the Host still falls back to its own workspace registry */
        }
        return out;
      }

      /** A stable key for the set of registered workspaces. */
      function workspaceListKey(ctx) {
        return allWorkspacePaths(ctx).sort().join('\n');
      }

      /** The selected Session id, from the Workspace selection store or the on-screen Session. */
      function selectedSessionId(ctx) {
        try {
          var ui = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
          var selection = ui && ui.selection && typeof ui.selection.getSnapshot === 'function' ? ui.selection.getSnapshot() : null;
          var id = selection && typeof selection.sessionId === 'string' ? selection.sessionId : '';
          if (id) return id;
        } catch (error) {
          /* fall through to the on-screen Session */
        }
        try {
          var sidebarRight = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null;
          var mounted = sidebarRight && sidebarRight.mounted && typeof sidebarRight.mounted.getSnapshot === 'function'
            ? sidebarRight.mounted.getSnapshot()
            : undefined;
          if (typeof mounted === 'string') return mounted;
        } catch (error) {
          /* no on-screen Session */
        }
        return '';
      }

      /** The directory one Session works in, using the live projection first. */
      function sessionDirectory(sessions, sessionId) {
        if (!sessions || !sessionId) return '';
        try {
          var binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : null;
          var session = binding && binding.session;
          var projections = session && session.projections;
          var face = projections && typeof projections.faceOf === 'function' ? projections.faceOf('workingDirectory') : null;
          var live = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : null;
          if (typeof live === 'string' && live) return live;
        } catch (error) {
          /* an unmaterialized Session has no live projection */
        }
        try {
          var state = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null;
          if (!state) return '';
          var bySession = state.projectionsBySession && state.projectionsBySession[sessionId];
          var projectedCwd = bySession && bySession.values && bySession.values.workingDirectory;
          if (typeof projectedCwd === 'string' && projectedCwd) return projectedCwd;
          var row = state.byId && state.byId[sessionId];
          var rowProjectedCwd = row && row.projectionValues && row.projectionValues.workingDirectory;
          if (typeof rowProjectedCwd === 'string' && rowProjectedCwd) return rowProjectedCwd;
          if (row && typeof row.cwd === 'string' && row.cwd) return row.cwd;
        } catch (error) {
          /* a malformed snapshot degrades to the empty state */
        }
        return '';
      }

      /** Keep the last selected Session and its directory across panel mounts. */
      function refreshActive(ctx) {
        var id = selectedSessionId(ctx);
        if (!id) return;
        var sessions = null;
        try {
          sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null;
        } catch (error) {
          sessions = null;
        }
        var cwd = sessionDirectory(sessions, id);
        if (id !== shared.active.sessionId) {
          shared.active.sessionId = id;
          shared.active.cwd = cwd;
        } else if (cwd && cwd !== shared.active.cwd) {
          shared.active.cwd = cwd;
        }
      }

      /** Watch the stores that change when the user switches Session or Workspace. */
      function bindActiveWorkspace(ctx) {
        refreshActive(ctx);
        var stops = [];
        function watch(service, key) {
          try {
            var source = service && service[key];
            if (source && typeof source.subscribe === 'function') {
              stops.push(source.subscribe(function () { refreshActive(ctx); }));
            }
          } catch (error) {
            /* a service without this store is simply not watched */
          }
        }
        try {
          watch(ctx.get('uiWorkspace'), 'selection');
          watch(ctx.get('sidebarRight'), 'mounted');
          watch(ctx.get('sessions'), 'list');
        } catch (error) {
          /* the panel still reads whatever the services expose per render */
        }
        return function () {
          for (var index = 0; index < stops.length; index += 1) {
            try { stops[index](); } catch (error) { /* already disposed */ }
          }
        };
      }

      /** A stable key for the selected Session and its directory. */
      function activeWorkspaceKey() {
        return String(shared.active.sessionId || '') + '|' + String(shared.active.cwd || '');
      }

      /** Ask the Host for one snapshot of the workspace `.rsi` tree. */
      function fetchOverview(hints) {
        var pairs = ['scope=global'];
        if (hints && hints.length) {
          for (var index = 0; index < hints.length; index += 1) pairs.push('cwd=' + encodeURIComponent(hints[index]));
        }
        var search = '?' + pairs.join('&');
        return fetch(API_PATH + search, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        }).then(function (response) {
          return response.text().then(function (text) {
            var body = null;
            try {
              body = text ? JSON.parse(text) : null;
            } catch (error) {
              body = null;
            }
            if (!response.ok) {
              var message = body && body.message ? body.message : 'HTTP ' + response.status;
              throw new Error(message);
            }
            if (!body || typeof body !== 'object') throw new Error('empty response');
            return body;
          });
        });
      }

      /* ------------------------------------------------------------- styling */

      var muted = 'color-mix(in srgb, currentColor 60%, transparent)';
      var faint = 'color-mix(in srgb, currentColor 38%, transparent)';
      var hairline = '1px solid color-mix(in srgb, currentColor 14%, transparent)';
      var cardBackground = 'color-mix(in srgb, currentColor 4%, transparent)';
      var mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

      var TONE = {
        passed: { fg: '#128a43', bg: 'color-mix(in srgb, #128a43 16%, transparent)' },
        failed: { fg: '#c2331f', bg: 'color-mix(in srgb, #c2331f 16%, transparent)' },
        pending: { fg: '#a86a00', bg: 'color-mix(in srgb, #a86a00 18%, transparent)' },
        approved: { fg: '#1a6fd4', bg: 'color-mix(in srgb, #1a6fd4 16%, transparent)' },
        applied: { fg: '#128a43', bg: 'color-mix(in srgb, #128a43 16%, transparent)' },
        rejected: { fg: '#c2331f', bg: 'color-mix(in srgb, #c2331f 16%, transparent)' },
        neutral: { fg: 'inherit', bg: 'color-mix(in srgb, currentColor 10%, transparent)' },
      };

      function toneFor(status) {
        if (status === 'passed' || status === 'applied') return TONE.passed;
        if (status === 'failed' || status === 'rejected') return TONE.failed;
        if (status === 'pending') return TONE.pending;
        if (status === 'approved') return TONE.approved;
        return TONE.neutral;
      }

      function statusText(status) {
        if (status === 'passed') return t('statusPassed');
        if (status === 'failed') return t('statusFailed');
        if (status === 'unscored') return t('statusUnscored');
        if (status === 'planned') return t('statusPlanned');
        if (status === 'archived') return t('statusArchived');
        if (status === 'pending') return t('pending');
        if (status === 'approved') return t('approved');
        if (status === 'rejected') return t('rejected');
        if (status === 'applied') return t('applied');
        return t('unknown');
      }

      /* ---------------------------------------------------------- components */

      function Badge(props) {
        var tone = props.tone || TONE.neutral;
        return h(
          'span',
          {
            style: {
              display: 'inline-block',
              padding: '1px 7px',
              borderRadius: 999,
              fontSize: 11,
              lineHeight: '18px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              color: tone.fg,
              background: tone.bg,
            },
          },
          props.children,
        );
      }

      function StatCard(props) {
        return h(
          'div',
          {
            style: {
              minWidth: 0,
              padding: '10px 12px',
              borderRadius: 10,
              border: hairline,
              background: cardBackground,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            },
          },
          h('div', { style: { fontSize: 11.5, color: muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, props.label),
          h(
            'div',
            { style: { fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em', display: 'flex', alignItems: 'baseline', gap: 6 } },
            h('span', null, props.value),
            props.tone ? h(Badge, { tone: props.tone }, props.badge) : null,
          ),
          props.detail ? h('div', { style: { fontSize: 11.5, color: faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, props.detail) : null,
        );
      }

      function Pre(props) {
        return h(
          'pre',
          {
            style: {
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              border: hairline,
              background: cardBackground,
              fontFamily: mono,
              fontSize: 11.5,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflow: 'auto',
              maxHeight: props.maxHeight || 300,
            },
          },
          props.children,
        );
      }

      function Field(props) {
        return h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, alignItems: 'start', fontSize: 12 } },
          h('span', { style: { color: muted } }, props.label),
          h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, props.children),
        );
      }

      function DetailPlaceholder() {
        return h('div', { style: { padding: '18px 4px', color: faint, fontSize: 12 } }, t('detailPlaceholder'));
      }

      function EmptyState(props) {
        return h(
          'div',
          { style: { padding: '28px 20px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', textAlign: 'center' } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, props.title),
          h('div', { style: { fontSize: 12, color: muted, maxWidth: 460, lineHeight: 1.6 } }, props.detail),
          props.tried && props.tried.length
            ? h(
                'div',
                { style: { marginTop: 6, textAlign: 'left', width: '100%', maxWidth: 460 } },
                h('div', { style: { fontSize: 11, color: faint, marginBottom: 4 } }, t('triedPaths')),
                h(
                  Pre,
                  { maxHeight: 140 },
                  props.tried.map(function (item, index) {
                    return h('div', { key: index }, item);
                  }),
                ),
              )
            : null,
        );
      }

      /* -------------------------------------------------------------- panels */

      function RunDetail(props) {
        var run = props.run;
        var statusTone = toneFor(run.status);
        var lines = [
          h(Field, { key: 'id', label: 'runId' }, h('span', { style: { fontFamily: mono } }, run.runId)),
          h(
            Field,
            { key: 'status', label: 'status' },
            h(Badge, { tone: statusTone }, statusText(run.status)),
            run.archived ? h('span', { style: { marginLeft: 6, color: faint, fontSize: 11 } }, t('statusArchived')) : null,
          ),
          h(Field, { key: 'variants', label: t('variants') }, String(run.variantCount || 0) + ' · ' + String(run.passedCount || 0) + ' ' + t('variantsPassed')),
          h(Field, { key: 'repeats', label: t('repeats') }, run.repeats === null || run.repeats === undefined ? '—' : String(run.repeats)),
          h(Field, { key: 'passRate', label: t('passRate') }, percent(run.passRate)),
          h(
            Field,
            { key: 'score', label: t('score') },
            run.score === null || run.score === undefined
              ? '—'
              : String(run.score) + (run.maxTotal === null || run.maxTotal === undefined ? '' : ' / ' + run.maxTotal),
          ),
          h(Field, { key: 'rubric', label: t('rubric') }, run.rubricHashVerified ? t('rubricOk') : t('rubricUnverified')),
          run.createdAt ? h(Field, { key: 'created', label: t('created') }, clock(run.createdAt)) : null,
          run.updatedAt ? h(Field, { key: 'updated', label: t('updated') }, clock(run.updatedAt)) : null,
          run.parent ? h(Field, { key: 'parent', label: t('parent') }, h('span', { style: { fontFamily: mono } }, run.parent)) : null,
          run.workspace ? h(Field, { key: 'ws', label: t('workspace') }, h('span', { style: { fontFamily: mono, fontSize: 11.5 } }, run.workspace)) : null,
          run.diagnostics && run.diagnostics.length
            ? h(
                Field,
                { key: 'diag', label: 'diagnostics' },
                run.diagnostics.map(function (item, index) {
                  return h('div', { key: index, style: { color: TONE.pending.fg, fontSize: 11.5 } }, item);
                }),
              )
            : null,
        ];

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, run.runId),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, lines),
          run.variants && run.variants.length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                run.variants.map(function (variant, index) {
                  var tone = variant.passed === true ? TONE.passed : variant.passed === false ? TONE.failed : TONE.neutral;
                  return h(
                    'div',
                    {
                      key: index,
                      style: { border: hairline, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' } },
                      h('span', { style: { fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, variant.label),
                      h(
                        'span',
                        { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
                        h(Badge, { tone: tone }, percent(variant.passRate)),
                        h(
                          'span',
                          { style: { fontSize: 11, color: faint } },
                          (variant.score === null || variant.score === undefined
                            ? '—'
                            : String(variant.score) + (variant.max === null || variant.max === undefined ? '' : '/' + variant.max)) +
                            ' · ' +
                            (variant.executed === null || variant.executed === undefined ? '—' : String(variant.executed)) +
                            '/' +
                            (variant.repeats === null || variant.repeats === undefined ? '—' : String(variant.repeats)),
                        ),
                      ),
                    ),
                    variant.rows && variant.rows.length
                      ? h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                          variant.rows.map(function (row, rowIndex) {
                            var ok = row.ok === true;
                            var failed = row.ok === false;
                            return h(
                              'div',
                              { key: rowIndex, style: { display: 'flex', gap: 6, fontSize: 11.5, color: failed ? TONE.failed.fg : undefined } },
                              h('span', { style: { width: 10, flexShrink: 0, color: ok ? TONE.passed.fg : failed ? TONE.failed.fg : faint } }, ok ? '✓' : failed ? '✗' : '·'),
                              h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, row.label),
                              row.detail ? h('span', { style: { color: faint, flexShrink: 0 } }, clip(row.detail, 60)) : null,
                            );
                          }),
                        )
                      : null,
                  );
                }),
              )
            : null,
          run.reportMd
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: { fontSize: 12, color: muted } }, t('reportTitle')),
                h(Pre, null, run.reportMd),
              )
            : null,
        );
      }

      function ProposalDetail(props) {
        var proposal = props.proposal;
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, proposal.title || proposal.id),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h(Field, { label: 'id' }, h('span', { style: { fontFamily: mono } }, proposal.id)),
            h(Field, { label: 'status' }, h(Badge, { tone: toneFor(proposal.status) }, statusText(proposal.status))),
            proposal.createdAt ? h(Field, { label: t('created') }, clock(proposal.createdAt)) : null,
            proposal.hypothesis ? h(Field, { label: t('hypothesis') }, proposal.hypothesis) : null,
            proposal.evidence ? h(Field, { label: t('evidenceRef') }, proposal.evidence) : null,
            proposal.changes && proposal.changes.length
              ? h(
                  Field,
                  { label: t('changes') },
                  proposal.changes.map(function (change, index) {
                    return h(
                      'div',
                      { key: index, style: { marginBottom: 3 } },
                      h('span', { style: { fontFamily: mono, fontSize: 11.5 } }, change.file || '—'),
                      h('span', { style: { color: muted } }, change.description ? ' — ' + change.description : ''),
                    );
                  }),
                )
              : null,
          ),
          proposal.body ? h(Pre, { maxHeight: 420 }, proposal.body) : null,
        );
      }

      function EvidenceDetail(props) {
        var record = props.record;
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, record.tool || record.source || t('tabEvidence')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            record.ts ? h(Field, { label: t('timeLabel') }, clock(record.ts) + ' · ' + record.ts) : null,
            record.source ? h(Field, { label: t('sourceLabel') }, record.source) : null,
            record.tool ? h(Field, { label: t('toolLabel') }, record.tool) : null,
            record.file ? h(Field, { label: t('fileLabel') }, h('span', { style: { fontFamily: mono, fontSize: 11.5 } }, record.file)) : null,
            record.args ? h(Field, { label: t('argsLabel') }, h('span', { style: { fontFamily: mono, fontSize: 11.5 } }, record.args)) : null,
          ),
          record.error ? h(Pre, { maxHeight: 420 }, record.error) : null,
        );
      }

      function LessonDetail(props) {
        var lesson = props.lesson;
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, wordBreak: 'break-word' } }, lesson.title),
          lesson.body ? h(Pre, { maxHeight: 460 }, lesson.body) : null,
        );
      }

      function LedgerLessonDetail(props) {
        var lesson = props.lesson;
        var sources = Array.isArray(lesson.sources) ? lesson.sources : [];
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, wordBreak: 'break-word' } }, lesson.title),
          lesson.body ? h(Pre, { maxHeight: 460 }, lesson.body) : null,
          sources.length
            ? h(Field, { key: 'sources', label: t('sourceLabel') }, h(Pre, { maxHeight: 150 }, sources.join('\n')))
            : null,
          lesson.lastSeenAt ? h(Field, { key: 'updated', label: t('updated') }, clock(lesson.lastSeenAt)) : null,
        );
      }

      function LedgerProposalDetail(props) {
        var proposal = props.proposal;
        var sources = Array.isArray(proposal.sources) ? proposal.sources : [];
        var body = proposal.body || proposal.hypothesis || proposal.summary || '';
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, wordBreak: 'break-word' } }, proposal.title || proposal.id),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(Badge, { tone: toneFor(proposal.status) }, statusText(proposal.status)),
            proposal.id ? h('span', { style: { fontSize: 11, color: faint, fontFamily: mono } }, proposal.id) : null,
          ),
          body ? h(Pre, { maxHeight: 420 }, body) : null,
          sources.length
            ? h(Field, { key: 'sources', label: t('sourceLabel') }, h(Pre, { maxHeight: 150 }, sources.join('\n')))
            : null,
          proposal.lastSeenAt || proposal.createdAt
            ? h(Field, { key: 'updated', label: t('updated') }, clock(proposal.lastSeenAt || proposal.createdAt))
            : null,
        );
      }

      /* -------------------------------------------------------------- shell */

      function RsiOverview(props) {
        var context = shared.ctx;
        var [state, setState] = useState({ phase: 'loading', data: null, error: null, at: null });
        var [tab, setTab] = useState('runs');
        var [selection, setSelection] = useState(null);
        var [workspaceFilter, setWorkspaceFilter] = useState('');
        var [syncState, setSyncState] = useState({ phase: 'idle', error: null, note: null });
        var hintsRef = useRef(null);
        var propsRef = useRef(props);
        propsRef.current = props;
        var mountedRef = useRef(true);
        var requestRef = useRef(0);

        function hints() {
          if (hintsRef.current) return hintsRef.current;
          /* The registered workspace list is the primary source: this panel is
           * global, so every workspace with `.rsi` must be scanned, not only the
           * conversation currently on screen. Scanned UI strings are fallbacks
           * for the first paint before the workspace list is available. */
          var ordered = [];
          var known = {};
          function add(value) {
            if (typeof value !== 'string') return;
            var path = value.trim().replace(/[\\/]+$/, '');
            if (!path || known[path] || ordered.length >= MAX_HINTS) return;
            known[path] = true;
            ordered.push(path);
          }
          var workspacePaths = allWorkspacePaths(context);
          for (var workspaceIndex = 0; workspaceIndex < workspacePaths.length; workspaceIndex += 1) add(workspacePaths[workspaceIndex]);

          var sources = [propsRef.current, shared.boot];
          var names = ['workspaces', 'uiWorkspace', 'layout', 'sessions'];
          for (var index = 0; index < names.length; index += 1) {
            var service = null;
            try {
              service = context && typeof context.get === 'function' ? context.get(names[index]) : null;
            } catch (error) {
              service = null;
            }
            if (!service) continue;
            var snapshots = serviceSnapshots(service);
            for (var snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) sources.push(snapshots[snapshotIndex]);
          }
          var collected = [];
          try {
            collected = collectPathHints(sources);
          } catch (error) {
            collected = [];
          }
          for (var collectedIndex = 0; collectedIndex < collected.length; collectedIndex += 1) add(collected[collectedIndex]);
          hintsRef.current = ordered;
          return ordered;
        }

        function load(force) {
          requestRef.current += 1;
          var token = requestRef.current;
          setState(function (previous) {
            return { phase: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null, at: previous.at };
          });
          if (force) hintsRef.current = null;
          fetchOverview(hints()).then(
            function (data) {
              if (!mountedRef.current || token !== requestRef.current) return;
              setState({ phase: 'ready', data: data, error: null, at: Date.now() });
            },
            function (error) {
              if (!mountedRef.current || token !== requestRef.current) return;
              setState(function (previous) {
                return { phase: 'error', data: previous.data, error: error && error.message ? error.message : String(error), at: previous.at };
              });
            },
          );
        }

        function syncLedger() {
          if (syncState.phase === 'syncing') return;
          setSyncState({ phase: 'syncing', error: null, note: null });
          var paths = [];
          try {
            paths = allWorkspacePaths(context);
          } catch (error) {
            paths = [];
          }
          fetch(SYNC_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ workspaces: paths }),
          }).then(function (response) {
            return response.text().then(function (text) {
              var body = null;
              try {
                body = text ? JSON.parse(text) : null;
              } catch (error) {
                body = null;
              }
              if (!response.ok) {
                throw new Error(body && (body.message || body.error) ? body.message || body.error : 'HTTP ' + response.status);
              }
              if (!body || body.ok !== true) {
                throw new Error(body && body.error ? body.error : t('syncFailed'));
              }
              return body;
            });
          }).then(function (result) {
            if (!mountedRef.current) return;
            var added = String(result.addedLessons || 0) + ' ' + t('ledgerLesson') + ' · ' + String(result.addedProposals || 0) + ' ' + t('ledgerProposal');
            setSyncState({
              phase: 'done',
              error: null,
              note: t('syncAdded') + ' · +' + added,
            });
            load(true);
          }).catch(function (error) {
            if (!mountedRef.current) return;
            setSyncState({ phase: 'error', error: error && error.message ? error.message : String(error), note: null });
          });
        }

        useEffect(function () {
          mountedRef.current = true;
          load(false);
          var lastKey = workspaceListKey(context);
          var pending = null;
          function check() {
            var key = workspaceListKey(context);
            if (key === lastKey) return;
            lastKey = key;
            hintsRef.current = null;
            load(true);
          }
          function schedule() {
            if (pending) clearTimeout(pending);
            pending = setTimeout(function () {
              pending = null;
              check();
            }, 90);
          }
          var stops = [];
          function watch(service, key) {
            try {
              var source = service && service[key];
              if (source && typeof source.subscribe === 'function') {
                stops.push(source.subscribe(schedule));
              }
            } catch (error) {
              /* a service without this store is simply not watched */
            }
          }
          try {
            watch(context && typeof context.get === 'function' ? context.get('workspaces') : null, 'list');
          } catch (error) {
            /* the interval below still notices a changed workspace list */
          }
          var interval = setInterval(check, 5000);
          return function () {
            mountedRef.current = false;
            clearInterval(interval);
            if (pending) clearTimeout(pending);
            for (var index = 0; index < stops.length; index += 1) {
              try { stops[index](); } catch (error) { /* already disposed */ }
            }
          };
        }, []);

        var data = state.data;
        var summary = data && data.summary ? data.summary : null;
        var busy = state.phase === 'loading' || state.phase === 'refreshing';
        var isGlobal = !!(data && data.scope === 'global');
        var workspaceOptions = useMemo(
          function () {
            var list = data && Array.isArray(data.workspaces) ? data.workspaces : [];
            return list.map(function (item) {
              return {
                value: item.workspace,
                label: item.name || item.workspace,
                count: item.summary && item.summary.runs ? item.summary.runs.total : 0,
              };
            });
          },
          [data],
        );

        var tabs = useMemo(
          function () {
            if (!data || !data.exists) return [];
            var proposals = data.proposals || { items: [] };
            var evidence = data.evidence || { items: [] };
            var lessons = data.lessons || { items: [] };
            var ledger = data.ledger || { lessons: [], proposals: [] };
            return [
              { key: 'runs', label: t('tabRuns'), count: (data.runs || []).length },
              { key: 'proposals', label: t('tabProposals'), count: proposals.total ?? (proposals.items || []).length },
              { key: 'evidence', label: t('tabEvidence'), count: evidence.count ?? (evidence.items || []).length },
              { key: 'lessons', label: t('tabLessons'), count: lessons.count ?? (lessons.items || []).length },
              {
                key: 'ledger',
                label: t('tabLedger'),
                count: (ledger.lessons || []).length + (ledger.proposals || []).length,
              },
            ];
          },
          [data],
        );

        var rows = useMemo(
          function () {
            if (!data || !data.exists) return [];
            var match = function (item) {
              return !workspaceFilter || item.workspace === workspaceFilter;
            };
            var prefix = function (item, value) {
              var name = item.workspaceName ? item.workspaceName + ' · ' : '';
              return name + value;
            };
            if (tab === 'runs') {
              return (data.runs || []).filter(match).map(function (run) {
                return {
                  key: 'run:' + run.workspace + ':' + run.runId,
                  title: run.runId,
                  badge: statusText(run.status),
                  tone: toneFor(run.status),
                  meta: prefix(
                    run,
                    percent(run.passRate) +
                      ' · ' +
                      String(run.variantCount || 0) +
                      ' ' +
                      t('variants') +
                      (run.repeats ? ' · r' + run.repeats : ''),
                  ),
                  time: clock(run.updatedAt),
                  payload: { kind: 'run', run: run },
                };
              });
            }
            if (tab === 'proposals') {
              return ((data.proposals || {}).items || []).filter(match).map(function (proposal) {
                return {
                  key: 'proposal:' + proposal.workspace + ':' + proposal.id,
                  title: proposal.title || proposal.id,
                  badge: statusText(proposal.status),
                  tone: toneFor(proposal.status),
                  meta: prefix(proposal, proposal.id),
                  time: clock(proposal.createdAt),
                  payload: { kind: 'proposal', proposal: proposal },
                };
              });
            }
            if (tab === 'evidence') {
              return ((data.evidence || {}).items || []).filter(match).map(function (record, index) {
                return {
                  key: 'evidence:' + record.workspace + ':' + index + ':' + (record.ts || ''),
                  title: (record.tool || record.source || t('tabEvidence')) + ' · ' + clip(record.error, 80),
                  badge: record.source || null,
                  tone: TONE.failed,
                  meta: prefix(record, record.file),
                  time: clock(record.ts),
                  payload: { kind: 'evidence', record: record },
                };
              });
            }
            if (tab === 'ledger') {
              var ledger = data.ledger || { lessons: [], proposals: [] };
              var entries = [];
              (ledger.lessons || []).forEach(function (item, index) {
                entries.push({
                  key: 'ledger:lesson:' + (item.key || index),
                  title: item.title || t('ledgerLesson'),
                  badge: t('ledgerLesson'),
                  tone: TONE.neutral,
                  meta: (item.sources || []).length + ' ' + t('ledgerSources'),
                  time: item.lastSeenAt ? clock(item.lastSeenAt) : '',
                  payload: { kind: 'ledgerLesson', lesson: item },
                });
              });
              (ledger.proposals || []).forEach(function (item, index) {
                entries.push({
                  key: 'ledger:proposal:' + (item.key || item.id || index),
                  title: item.title || item.id || t('ledgerProposal'),
                  badge: statusText(item.status),
                  tone: toneFor(item.status),
                  meta: (item.sources || []).length + ' ' + t('ledgerSources'),
                  time: item.lastSeenAt || item.createdAt ? clock(item.lastSeenAt || item.createdAt) : '',
                  payload: { kind: 'ledgerProposal', proposal: item },
                });
              });
              return entries;
            }
            return ((data.lessons || {}).items || []).filter(match).map(function (lesson, index) {
              return {
                key: 'lesson:' + lesson.workspace + ':' + index + ':' + lesson.title,
                title: lesson.title,
                badge: null,
                tone: TONE.neutral,
                meta: lesson.workspaceName || '',
                time: '',
                payload: { kind: 'lesson', lesson: lesson },
              };
            });
          },
          [data, tab, workspaceFilter],
        );

        var selected = useMemo(
          function () {
            if (!selection) return null;
            for (var index = 0; index < rows.length; index += 1) {
              if (rows[index].key === selection) return rows[index].payload;
            }
            return null;
          },
          [rows, selection],
        );

        useEffect(
          function () {
            if (!selection) return;
            var found = false;
            for (var index = 0; index < rows.length; index += 1) {
              if (rows[index].key === selection) {
                found = true;
                break;
              }
            }
            if (!found) setSelection(null);
          },
          [rows, selection],
        );

        function renderDetail() {
          if (!selected) return h(DetailPlaceholder);
          if (selected.kind === 'run') return h(RunDetail, { run: selected.run });
          if (selected.kind === 'proposal') return h(ProposalDetail, { proposal: selected.proposal });
          if (selected.kind === 'evidence') return h(EvidenceDetail, { record: selected.record });
          if (selected.kind === 'lesson') return h(LessonDetail, { lesson: selected.lesson });
          if (selected.kind === 'ledgerLesson') return h(LedgerLessonDetail, { lesson: selected.lesson });
          if (selected.kind === 'ledgerProposal') return h(LedgerProposalDetail, { proposal: selected.proposal });
          return h(DetailPlaceholder);
        }

        function renderBody() {
          if (state.phase === 'loading') {
            return h('div', { style: { padding: '26px 4px', color: muted, fontSize: 12 } }, t('refreshing'));
          }
          if (state.phase === 'error') {
            return h(
              'div',
              { style: { padding: '24px 4px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' } },
              h('div', { style: { fontSize: 13, fontWeight: 600, color: TONE.failed.fg } }, t('loadFailed')),
              h('div', { style: { fontSize: 12, color: muted, wordBreak: 'break-word' } }, state.error),
              h(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    load(true);
                  },
                  style: {
                    padding: '5px 12px',
                    borderRadius: 7,
                    border: hairline,
                    background: cardBackground,
                    color: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                  },
                },
                t('retry'),
              ),
            );
          }
          if (!data) return h(DetailPlaceholder);
          if (!data.exists) {
            var globalEmpty = data.reason === 'no-global-workspace';
            var noWorkspace = data.reason === 'no-workspace';
            var tried = data.resolution && data.resolution.tried ? data.resolution.tried : [];
            return h(EmptyState, {
              title: globalEmpty ? t('emptyGlobalTitle') : noWorkspace ? t('emptyNoWorkspace') : t('emptyTitle'),
              detail: globalEmpty ? t('emptyGlobalDetail') : noWorkspace ? t('emptyNoWorkspaceDetail') : t('emptyDetail'),
              tried: tried,
            });
          }
          /* The tab bar must stay reachable even when the active tab has no
           * rows, so an empty tab renders a note inside the list column. */
          var listNote = null;
          if (!rows.length) {
            listNote = t('listEmptyRuns');
            if (tab === 'proposals') listNote = t('listEmptyProposals');
            else if (tab === 'evidence') listNote = t('listEmptyEvidence');
            else if (tab === 'lessons') listNote = t('listEmptyLessons');
            else if (tab === 'ledger') listNote = t('ledgerEmpty');
            listNote = t('listEmpty') + ' · ' + listNote;
          }
          return h(
            'div',
            { style: { flex: 1, minHeight: 0, display: 'flex', gap: 12 } },
            h(
              'div',
              { style: { width: '38%', minWidth: 230, display: 'flex', flexDirection: 'column', minHeight: 0 } },
              h(
                'div',
                { style: { display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' } },
                tabs.map(function (item) {
                  var active = item.key === tab;
                  return h(
                    'button',
                    {
                      key: item.key,
                      type: 'button',
                      onClick: function () {
                        setTab(item.key);
                        setSelection(null);
                      },
                      style: {
                        padding: '3px 9px',
                        fontSize: 11.5,
                        borderRadius: 7,
                        border: active ? '1px solid color-mix(in srgb, currentColor 26%, transparent)' : '1px solid transparent',
                        background: active ? cardBackground : 'transparent',
                        color: active ? 'inherit' : muted,
                        cursor: 'pointer',
                        fontWeight: active ? 600 : 400,
                      },
                    },
                    item.label,
                    item.count ? h('span', { style: { marginLeft: 5, color: faint } }, String(item.count)) : null,
                  );
                }),
              ),
              h(
                'div',
                { style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 4 } },
                listNote
                  ? h('div', { style: { padding: '16px 4px', fontSize: 12, color: muted, lineHeight: 1.65 } }, listNote)
                  : null,
                rows.map(function (row) {
                  var active = row.key === selection;
                  return h(
                    'button',
                    {
                      key: row.key,
                      type: 'button',
                      onClick: function () {
                        setSelection(row.key);
                      },
                      style: {
                        textAlign: 'left',
                        padding: '7px 9px',
                        borderRadius: 8,
                        border: active ? '1px solid color-mix(in srgb, currentColor 24%, transparent)' : hairline,
                        background: active ? 'color-mix(in srgb, currentColor 9%, transparent)' : 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        font: 'inherit',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' } },
                      h('span', { style: { fontSize: 12, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title),
                      row.badge ? h(Badge, { tone: row.tone }, row.badge) : null,
                    ),
                    row.meta || row.time
                      ? h(
                          'div',
                          { style: { display: 'flex', gap: 8, fontSize: 11, color: faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                          row.meta ? h('span', null, row.meta) : null,
                          row.time ? h('span', { style: { marginLeft: 'auto' } }, row.time) : null,
                        )
                      : null,
                  );
                }),
              ),
            ),
            h(
              'div',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  overflow: 'auto',
                  borderLeft: hairline,
                  paddingLeft: 14,
                  paddingRight: 4,
                },
              },
              renderDetail(),
            ),
          );
        }

        var summaryCards = [];
        if (summary) {
          var last = summary.lastCollect;
          summaryCards.push({
            key: 'runs',
            label: t('statRuns'),
            value: String(summary.runs.total),
            detail: t('runsActive') + ' ' + summary.runs.active + ' · ' + t('runsArchived') + ' ' + summary.runs.archived,
            tone: null,
            badge: null,
          });
          summaryCards.push({
            key: 'pass',
            label: t('statPassRate'),
            value: last ? percent(last.passRate) : '—',
            detail: last
              ? last.runId + ' · ' + last.passedCount + '/' + last.variantCount + ' ' + t('variantsPassed')
              : t('noCollect'),
            tone: last ? toneFor(last.status) : null,
            badge: last ? statusText(last.status) : null,
          });
          summaryCards.push({
            key: 'proposals',
            label: t('statProposals'),
            value: String(summary.proposals.pending),
            detail: summary.proposals.libraryExists
              ? t('approved') + ' ' + summary.proposals.approved + ' · ' + t('applied') + ' ' + summary.proposals.applied
              : t('libraryMissing'),
            tone: summary.proposals.pending > 0 ? TONE.pending : null,
            badge: summary.proposals.pending > 0 ? t('pending') : null,
          });
          summaryCards.push({
            key: 'evidence',
            label: t('statEvidence'),
            value: String(summary.evidence.count),
            detail: summary.evidence.files + ' ' + t('evidenceFiles'),
            tone: null,
            badge: null,
          });
          summaryCards.push({
            key: 'lessons',
            label: t('statLessons'),
            value: String(summary.lessons.count),
            detail: t('lessonBlocks'),
            tone: null,
            badge: null,
          });
        }

        return h(
          'div',
          { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 20px 18px', boxSizing: 'border-box' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
            h(
              'div',
              { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' } }, t('title')),
              h(
                'div',
                { style: { fontSize: 11.5, color: muted, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', null, isGlobal ? t('allWorkspaces') : t('workspace')),
                h(
                  'span',
                  {
                    style: { fontFamily: mono, fontSize: 11, color: 'inherit', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: isGlobal
                      ? workspaceOptions.map(function (item) { return item.value; }).join('\n')
                      : data && data.workspace
                        ? data.workspace
                        : '',
                  },
                  isGlobal
                    ? workspaceOptions.length + ' ' + t('workspaceUnit')
                    : data && data.workspace
                      ? data.workspace
                      : '—',
                ),
                state.at ? h('span', { style: { color: faint } }, '· ' + clock(new Date(state.at).toISOString())) : null,
              ),
            ),
            isGlobal && workspaceOptions.length && tab !== 'ledger'
              ? h(
                  'select',
                  {
                    value: workspaceFilter,
                    title: t('filterWorkspace'),
                    onChange: function (event) {
                      setWorkspaceFilter(event.target.value);
                      setSelection(null);
                    },
                    style: {
                      marginLeft: 'auto',
                      maxWidth: 220,
                      padding: '4px 8px',
                      borderRadius: 7,
                      border: hairline,
                      background: cardBackground,
                      color: 'inherit',
                      fontSize: 12,
                    },
                  },
                  h('option', { value: '' }, t('allWorkspaces')),
                  workspaceOptions.map(function (option) {
                    return h('option', { key: option.value, value: option.value }, option.label + ' (' + option.count + ')');
                  }),
                )
              : null,
            tab === 'ledger'
              ? h(
                  'button',
                  {
                    type: 'button',
                    disabled: syncState.phase === 'syncing',
                    onClick: syncLedger,
                    style: {
                      marginLeft: 'auto',
                      flexShrink: 0,
                      padding: '5px 12px',
                      borderRadius: 7,
                      border: hairline,
                      background: cardBackground,
                      color: 'inherit',
                      fontSize: 12,
                      cursor: syncState.phase === 'syncing' ? 'default' : 'pointer',
                      opacity: syncState.phase === 'syncing' ? 0.55 : 1,
                    },
                  },
                  syncState.phase === 'syncing' ? t('syncing') : t('syncLedger'),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: function () {
                  load(true);
                },
                style: {
                  marginLeft: tab === 'ledger' ? 8 : isGlobal && workspaceOptions.length ? 8 : 'auto',
                  flexShrink: 0,
                  padding: '5px 12px',
                  borderRadius: 7,
                  border: hairline,
                  background: cardBackground,
                  color: 'inherit',
                  fontSize: 12,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.55 : 1,
                },
              },
              busy ? t('refreshing') : t('refresh'),
            ),
          ),
          tab === 'ledger' && data && data.ledger
            ? h(
                'div',
                { style: { fontSize: 11, color: faint, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
                h('span', null, t('ledgerUpdated') + ' ' + (data.ledger.updatedAt ? clock(data.ledger.updatedAt) : t('ledgerNever'))),
                h(
                  'span',
                  null,
                  String(data.ledger.summary.lessons) +
                    ' ' +
                    t('ledgerLesson') +
                    ' · ' +
                    String(data.ledger.summary.proposals) +
                    ' ' +
                    t('ledgerProposal') +
                    ' · ' +
                    String(data.ledger.summary.workspaces) +
                    ' ' +
                    t('workspaceUnit'),
                ),
                h('span', null, t('ledgerHint')),
                syncState.note ? h('span', { style: { color: TONE.passed.fg } }, syncState.note) : null,
                syncState.error ? h('span', { style: { color: TONE.failed.fg } }, t('syncFailed') + ': ' + syncState.error) : null,
                data.ledger.path
                  ? h(
                      'span',
                      {
                        style: { marginLeft: 'auto', fontFamily: mono, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                        title: data.ledger.path,
                      },
                      data.ledger.path,
                    )
                  : null,
              )
            : null,
          summaryCards.length
            ? h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 } },
                summaryCards.map(function (card) {
                  return h(StatCard, {
                    key: card.key,
                    label: card.label,
                    value: card.value,
                    detail: card.detail,
                    tone: card.tone,
                    badge: card.badge,
                  });
                }),
              )
            : null,
          h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, renderBody()),
        );
      }

      /** A render error must not blank the slot: show the message instead. */
      function GuardedPanel(props) {
        var [failure, setFailure] = useState(null);
        if (failure) {
          return h(
            'div',
            { style: { padding: 20, fontSize: 12, color: TONE.failed.fg, wordBreak: 'break-word' } },
            t('loadFailed') + ': ' + failure,
          );
        }
        try {
          return h(RsiOverview, props);
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error));
          return null;
        }
      }

      /** Sidebar entry artwork: a flask, and the size/active props the shell passes. */
      function SidebarIcon(props) {
        var size = props && typeof props.size === 'number' ? props.size : 20;
        var active = !!(props && props.active);
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 2 : 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block', opacity: active ? 1 : 0.84 },
          },
          h('path', { d: 'M9 3h6' }),
          h('path', { d: 'M10 3v5.1L5.9 15.9A3 3 0 0 0 8.5 20.4h7a3 3 0 0 0 2.6-4.5L14 8.1V3' }),
          h('path', { d: 'M7.6 14.2h8.8' }),
        );
      }

      return {
        inject: ['slots'],
        apply: function apply(ctx) {
          if (!ctx || !ctx.slots) return;
          shared.ctx = ctx;
          shared.boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : null;

          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: function label() {
                  return t('entryLabel');
                },
              },
              SidebarIcon,
            );
          });

          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, GuardedPanel);
          });
        },
      };
    },
  });
})();
