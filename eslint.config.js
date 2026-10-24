import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Every Supabase .rpc() call must pass _trace_id (PRD section 24, Schema
// section 1). Prefer callRpc() from src/lib/rpc.ts, which adds it. Shared so
// blocks that override no-restricted-syntax keep it.
const rpcTraceId = {
  selector:
    "CallExpression[callee.property.name='rpc'] > ObjectExpression:not(:has(Property[key.name='_trace_id']))",
  message:
    'Supabase .rpc() calls must include _trace_id parameter. Use callRpc() from src/lib/rpc.ts instead.',
};

// Design rules (CLAUDE.md): raw sizes, radii, weights, hex and dark: in a
// className. text-legacy-* is allowed until the type migration PR removes it.
const DESIGN_CLASS =
  '/\\btext-\\[[0-9.]+(px|rem)\\]|\\brounded-\\[[0-9.]+px\\]|\\bdark:|\\bfont-\\[[0-9]+\\]|#[0-9a-fA-F]{3,8}\\b/';
const DESIGN_MESSAGE = 'Design rules: tokens and scale only (see CLAUDE.md)';
const designRules = [
  {
    selector: "JSXOpeningElement[name.name='button']",
    message: 'Use Button, IconButton or Chip from src/components/ui',
  },
  {
    selector: `JSXAttribute[name.name='className'] Literal[value=${DESIGN_CLASS}]`,
    message: DESIGN_MESSAGE,
  },
  {
    selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${DESIGN_CLASS}]`,
    message: DESIGN_MESSAGE,
  },
];

// Files that broke the design rules when they were locked (24 Oct 2026). They
// keep only the rpc guard until the type, radius and button migrations clear
// them; remove a file from this list once it is clean. Never add to it.
const designRulesBaseline = [
  'src/components/chat/AssetPicker.tsx',
  'src/components/chat/BriefCard.tsx',
  'src/components/chat/ChannelList.tsx',
  'src/components/chat/ChatInfoTabs.tsx',
  'src/components/chat/ComposerEmoji.tsx',
  'src/components/chat/ComposerTray.tsx',
  'src/components/chat/ConceptSheet.tsx',
  'src/components/chat/ContactSheet.tsx',
  'src/components/chat/EmojiPicker.tsx',
  'src/components/chat/FileBubble.tsx',
  'src/components/chat/ForwardPicker.tsx',
  'src/components/chat/GroupInfoSheet.tsx',
  'src/components/chat/InChatSearchBar.tsx',
  'src/components/chat/MarkBits.tsx',
  'src/components/chat/MarksSheet.tsx',
  'src/components/chat/MemberPicker.tsx',
  'src/components/chat/MessageActionMenu.tsx',
  'src/components/chat/MessageAttachments.tsx',
  'src/components/chat/MessageThread.tsx',
  'src/components/chat/NotesBits.tsx',
  'src/components/chat/PaintLog.tsx',
  'src/components/chat/PendingChip.tsx',
  'src/components/chat/PlanCard.tsx',
  'src/components/chat/PlanComposeScreen.tsx',
  'src/components/chat/PlanDayPickerSheet.tsx',
  'src/components/chat/PlanDayPopover.tsx',
  'src/components/chat/PlanItemScreen.tsx',
  'src/components/chat/PlanMoveSheet.tsx',
  'src/components/chat/PlanPickerSheet.tsx',
  'src/components/chat/PlanRowActions.tsx',
  'src/components/chat/PlanScreen.tsx',
  'src/components/chat/PostCard.tsx',
  'src/components/chat/PostPicker.tsx',
  'src/components/chat/PostRefChip.tsx',
  'src/components/chat/PostSheet.tsx',
  'src/components/chat/ReadingLayer.tsx',
  'src/components/chat/ReminderSheet.tsx',
  'src/components/chat/ReplyQuote.tsx',
  'src/components/chat/ScheduleSheet.tsx',
  'src/components/chat/ScheduledListSheet.tsx',
  'src/components/chat/ScheduledStrip.tsx',
  'src/components/chat/SearchResults.tsx',
  'src/components/chat/StarredList.tsx',
  'src/components/chat/StatusDrawer.tsx',
  'src/components/chat/StatusTicker.tsx',
  'src/components/chat/ThreadRail.tsx',
  'src/components/chat/ThreadView.tsx',
  'src/components/chat/UploadRing.tsx',
  'src/components/chat/VoiceNote.tsx',
  'src/components/chat/tasks/TaskEventLine.tsx',
  'src/components/chat/tasks/TaskRow.tsx',
  'src/components/chat/tasks/TaskSheet.tsx',
  'src/components/comments/CommentComposer.tsx',
  'src/components/comments/CommentEmojiButton.tsx',
  'src/components/comments/Comments.tsx',
  'src/components/comments/MentionInput.tsx',
  'src/components/induction/GuideParts.tsx',
  'src/components/induction/PresetMediaField.tsx',
  'src/components/media/PlatformFrame.tsx',
  'src/components/onboarding/OnboardingFlow.tsx',
  'src/components/pages/BriefDetailPage.tsx',
  'src/components/pages/CreatePostSheet.tsx',
  'src/components/pages/HelpPage.tsx',
  'src/components/pages/PlanTabPage.tsx',
  'src/components/pages/PostCard.tsx',
  'src/components/pages/PostDetailPage.tsx',
  'src/components/pages/activity/ActivityCard.tsx',
  'src/components/pages/activity/ActivityFilterBar.tsx',
  'src/components/pages/activity/AvatarStack.tsx',
  'src/components/pages/assets/AddLinkSheet.tsx',
  'src/components/pages/assets/AssetActionSheet.tsx',
  'src/components/pages/assets/AssetCard.tsx',
  'src/components/pages/assets/AssetLightbox.tsx',
  'src/components/pages/assets/AssetRenameSheet.tsx',
  'src/components/pages/assets/AssetTabs.tsx',
  'src/components/pages/assets/AssetUploadSheet.tsx',
  'src/components/pages/assets/Toasts.tsx',
  'src/components/pages/create/AttachmentsField.tsx',
  'src/components/pages/create/ComposerSheet.tsx',
  'src/components/pages/create/FileTiles.tsx',
  'src/components/pages/create/RemoveButton.tsx',
  'src/components/pages/pcs/CaptionView.tsx',
  'src/components/pages/pcs/CheckpointStrip.tsx',
  'src/components/pages/pcs/CompareVersionsView.tsx',
  'src/components/pages/pcs/PinOverlay.tsx',
  'src/components/pages/pcs/PostDetailsSheet.tsx',
  'src/components/pages/pcs/PostGallery.tsx',
  'src/components/pages/pcs/SlideActionsSheet.tsx',
  'src/components/pages/pcs/VersionHistorySheet.tsx',
  'src/components/pages/pipeline/MoveSheet.tsx',
  'src/components/pages/pipeline/PipelineDateRangeCalendar.tsx',
  'src/components/pages/pipeline/PipelineSortControl.tsx',
  'src/components/pages/plan-tab/PlanCalendar.tsx',
  'src/components/pages/plan-tab/PlanDayMenu.tsx',
  'src/components/pages/plan-tab/PlanTabList.tsx',
  'src/components/pages/settings/ApprovedAddressesSection.tsx',
  'src/components/pages/settings/MembersList.tsx',
  'src/components/pages/settings/StoragePanel.tsx',
  'src/components/pages/settings/WorkspaceSettingsPanel.tsx',
  'src/components/preview/PlatformPreviewPanel.tsx',
  'src/components/settings/ProfileSettingsPanel.tsx',
  'src/components/settings/UsernameField.tsx',
  'src/components/shell/BottomTabs.tsx',
  'src/components/shell/CommandPalette.tsx',
  'src/components/shell/MenuItem.tsx',
  'src/components/shell/NotificationsButton.tsx',
  'src/components/shell/PageHead.tsx',
  'src/components/shell/SectionHeader.tsx',
  'src/components/shell/Sidebar.tsx',
  'src/components/shell/Tabs.tsx',
  'src/components/shell/Topbar.tsx',
  'src/components/shell/WorkspaceSwitcher.tsx',
  'src/components/support/BookCallSheet.tsx',
  'src/components/support/ContactSheet.tsx',
  'src/components/test-site/TestSiteAnywhereStart.tsx',
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'packages/schemas/dist/**',
      // Supabase types are generated; the drift gate owns their shape.
      'packages/schemas/src/supabase.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error', rpcTraceId],
      // Force all requests through fetchWithTrace() so they carry X-Trace-Id.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use fetchWithTrace() from src/lib/fetch.ts so requests carry X-Trace-Id.',
        },
      ],
      // TODO: enable in a later PR - custom rule to forbid SELECT * in SQL queries
      // 'sorted/no-select-star': 'error',
      // TODO: tighten in later PRs - enforce src/lib boundaries via zones
      // 'import/no-restricted-paths': ['error', { zones: [/* src/lib boundary */] }],
    },
  },
  {
    // Design rules apply to app code; ui/ owns the primitives, home/ is the
    // marketing site with its own stylesheet.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/**',
      'src/components/home/**',
      'src/**/*.test.{ts,tsx}',
      'src/**/__tests__/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', rpcTraceId, ...designRules],
    },
  },
  {
    files: designRulesBaseline,
    rules: {
      'no-restricted-syntax': ['error', rpcTraceId],
    },
  },
  {
    // fetchWithTrace() is the single sanctioned wrapper around native fetch.
    files: ['src/lib/fetch.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    // All structured logging goes through logger from src/lib/logger.ts.
    // No console.* anywhere in first-party src/** code.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // The logger files are the single sanctioned console sink. Only warn/error
    // are permitted; the real level is carried in the JSON `level` field.
    files: ['src/lib/logger.ts', 'src/server/logger.ts'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
);
