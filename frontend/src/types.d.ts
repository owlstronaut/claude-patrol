export interface ExtensiblePayload {
  [field: string]: unknown;
}

export type CiStatus = 'pass' | 'fail' | 'pending';
export type ReviewStatus = 'approved' | 'changes_requested' | 'pending';
export type MergeableStatus = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface Check {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface PullRequestReview {
  reviewer: string;
  reviewer_type?: string;
  state: string;
  submitted_at: string;
}

export interface PullRequestComment {
  author: string;
  author_type?: string;
  created_at: string;
}

export interface PullRequestLabel {
  name: string;
  color: string;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  body_html: string;
  repo: string;
  org: string;
  author: string;
  url: string;
  branch: string;
  base_branch: string;
  is_fork: boolean;
  draft: boolean;
  mergeable: MergeableStatus;
  checks: Check[];
  reviews: PullRequestReview[];
  labels: PullRequestLabel[];
  comments: PullRequestComment[];
  created_at: string;
  updated_at: string;
  synced_at: string;
  ci_status: CiStatus;
  review_status: ReviewStatus;
  stack_parent: string | null;
  stack_children: string[];
  stack_depth: number;
  stack_root: string;
  is_stacked: boolean;
  stack_size: number;
  stack_position: number;
  has_workspace?: boolean;
  has_session?: boolean;
  workspace_id?: string | null;
  head_oid?: string | null;
  work_item_id: string | null;
  work_item: null | {
    id: string;
    reference: string;
    title: string | null;
    state: WorkItemState;
  };
}

export interface PullRequestFreshness {
  synced_at: string | null;
  stale: boolean;
  refreshing: boolean;
}

export interface PullRequestListResponse {
  prs: PullRequest[];
  synced_at: string | null;
  freshness: PullRequestFreshness;
}

export interface RemovedPullRequest {
  removed: true;
  state: 'CLOSED' | 'MERGED';
}

export type RefreshPullRequestResponse = PullRequest | RemovedPullRequest;

export interface Workspace {
  id: string;
  pr_id: string | null;
  name: string;
  path: string;
  bookmark: string;
  repo: string | null;
  status: 'active' | 'destroyed';
  created_at: string;
  destroyed_at: string | null;
  operation_state: string;
  operation_step: string | null;
  operation_error: string | null;
  operation_updated_at: string | null;
  work_item_id: string | null;
  start_revision: string | null;
  base_commit: string | null;
  setup_warnings_json: string | null;
}

export type SessionTarget =
  | { type: 'global' }
  | { type: 'workspace'; id: string }
  | { type: 'work_item'; id: string };

export interface Session {
  id: string;
  workspace_id: string | null;
  work_item_id: string | null;
  name: string | null;
  target: SessionTarget;
  activity_state: 'working' | 'idle' | null;
  pid: number | null;
  provider: AgentProvider;
  status: 'active' | 'detached' | 'killed';
  started_at: string;
  ended_at: string | null;
  claude_project_dir: string | null;
  transcript_path: string | null;
  ws_url?: string;
}

export type WorkItemState = 'resolving' | 'preparing' | 'ready' | 'error' | 'destroying' | 'destroyed';
export type WorkItemStage =
  | 'provider_check'
  | 'reference_resolution'
  | 'root_generation'
  | 'child_creation'
  | 'child_compensation'
  | 'session_launch'
  | 'session_stop'
  | 'transcript_archive'
  | 'child_destruction'
  | 'root_destruction'
  | 'complete';
export type WorkItemRetryAction = 'resolution' | 'preparation' | 'cleanup' | 'terminal';

export interface RecoveryAction {
  kind: 'command' | 'settings';
  label: string;
  command?: string;
  href?: string;
}

export interface WorkItemListItem {
  id: string;
  reference: string;
  title: string | null;
  work_provider: AgentProvider;
  resolver_provider: AgentProvider;
  state: WorkItemState;
  stage: WorkItemStage;
  progress: { current: number; total: number };
  repositories: string[];
  pull_request_count: number;
  pull_requests: WorkItemPullRequest[];
  updated_at: string;
  has_session_history: boolean;
  session: null | {
    id: string;
    status: 'active' | 'detached';
    activity_state: 'working' | 'idle' | null;
  };
  error: null | {
    code: string;
    failed_provider: AgentProvider | null;
    retry_action: WorkItemRetryAction | null;
  };
}

export interface WorkItemPullRequest {
  id: string;
  org: string;
  repo: string;
  repository: string;
  number: number;
  title: string | null;
  url: string;
  branch: string | null;
  base_branch: string | null;
  draft: boolean;
  mergeable: MergeableStatus;
  ci_status: CiStatus;
  review_status: ReviewStatus;
  updated_at: string | null;
  tracked: boolean;
  linked_at: string;
  link_source: 'explicit' | 'provenance';
}

export interface WorkItemRepository {
  identifier: string;
  workspace_id: string | null;
  state: 'pending' | 'ready' | 'removing' | 'removed' | 'error';
  path: string | null;
  checkout_available: boolean;
  bookmark: string;
  start_revision: string;
  base_commit: string | null;
  warnings: string[];
}

export interface WorkItemDetail extends Omit<WorkItemListItem, 'error'> {
  summary: string | null;
  root_path: string;
  created_at: string;
  destroyed_at: string | null;
  error: null | {
    code: string;
    detail: string | null;
    failed_provider: AgentProvider | null;
    retry_action: WorkItemRetryAction | null;
    recovery_actions: RecoveryAction[];
  };
  repository_workspaces: WorkItemRepository[];
}

export interface WorkItemListResponse {
  work_items: WorkItemListItem[];
}

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  detail: string | null;
  failed_provider: AgentProvider | null;
  retry_action: WorkItemRetryAction | null;
  recovery_actions: RecoveryAction[];
}

export interface CheckLog {
  run_id: string;
  job_name: string;
  failed_steps?: string[];
  log?: string;
  truncated?: boolean;
  error?: string;
}

export interface InlineReviewComment {
  path: string;
  diff_position: number | null;
  body_html: string;
  created_at: string;
}

export interface StructuredReview {
  id: number;
  author: string;
  state: string;
  body_html: string;
  submitted_at: string | null;
  comments: InlineReviewComment[];
}

export interface ConversationComment {
  author: string;
  body_html: string;
  created_at: string;
}

export interface PullRequestCommentsResponse {
  reviews: StructuredReview[];
  conversation: ConversationComment[];
}

export interface TranscriptBlock {
  type: string;
  text?: string;
  name?: string | null;
  input_summary?: string;
  output_summary?: string;
}

export interface TranscriptEntry {
  timestamp?: string;
  role: string;
  content: TranscriptBlock[];
  model: string | null;
  isHuman: boolean;
}

export type TaskStatus = 'running' | 'success' | 'warning' | 'error';

export interface Task {
  id: string;
  kind: string;
  label: string;
  status: TaskStatus;
  startedAt: string;
  endedAt: string | null;
  warnings: string[];
  error: string | null;
  context: ExtensiblePayload | null;
  progress: { current: number; total: number } | null;
}

export type RuleRunStatus = 'running' | 'success' | 'error';

export interface RuleRun {
  id: string;
  rule_id: string;
  trigger: string;
  pr_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
  status: RuleRunStatus;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface RuleDefinition {
  id: string;
  on: string;
  manual: boolean;
  requires_subscription: boolean;
  consume_on?: 'fire' | 'trigger';
  cooldown_minutes: number;
  where?: ExtensiblePayload;
  actions: ExtensiblePayload[];
}

export interface RuleLoadError {
  rule_id: string;
  error: string;
}

export interface RuleSubscription {
  rule_id: string;
  pr_id: string;
  created_at: string;
}

export interface BulkRuleItem {
  pr_id: string;
  reason?: string;
}

export interface BulkRuleRunResponse {
  fired: BulkRuleItem[];
  skipped: BulkRuleItem[];
}

export interface BulkRuleSubscriptionResponse {
  subscribed: BulkRuleItem[];
  already_subscribed: BulkRuleItem[];
  skipped: BulkRuleItem[];
}

export interface PublicConfig {
  poll: {
    orgs: string[];
    repos: string[];
    interval_seconds: number;
  };
  default_session_provider: AgentProvider;
  needs_setup: boolean;
  poll_configured: boolean;
  work_items: {
    configured: boolean;
    resolver: null | {
      provider_mode: 'fixed' | 'requested_provider';
      provider: AgentProvider | null;
      server_name: string;
    };
    repositories: string[];
    provider_setup: Record<
      AgentProvider,
      { model_login_command: string; resolver_mcp_commands: string[] }
    >;
  };
  update_available?: boolean;
  commits_behind?: number;
  restart_needed?: boolean;
  startup_sha?: string;
  current_sha?: string;
  capabilities?: {
    providers: Record<AgentProvider, ProviderCapability>;
  };
}

export type AgentProvider = 'claude' | 'codex';

export interface ProviderCapability {
  available: boolean;
  checking: boolean;
  reason: string | null;
  version: string | null;
  checkedAt: string | null;
}

export type PeerReviewStatus =
  | 'requested'
  | 'running'
  | 'delivering'
  | 'complete'
  | 'failed'
  | 'delivery_unconfirmed';

export interface PeerReview {
  id: string;
  workspaceId: string;
  sessionId: string;
  prId: string;
  presenterProvider: AgentProvider;
  reviewerProvider: AgentProvider;
  status: PeerReviewStatus;
  requestedAt: string;
  startedAt: string | null;
  resultReadyAt: string | null;
  endedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface PeerReviewStatusResponse {
  review: PeerReview | null;
  presenterProvider: AgentProvider | null;
  reviewerProvider: AgentProvider | null;
  ready: boolean;
  reason: string | null;
}

export interface RestartStatus {
  phase: string | null;
  started_at?: string;
}

export interface FilterState {
  org?: string[];
  repo?: string[];
  ci?: string[];
  review?: string[];
  mergeable?: string[];
  draft?: string[];
  needsWork?: boolean;
}

export type FilterListKey = 'org' | 'repo' | 'ci' | 'review' | 'mergeable' | 'draft';

export interface GhRateLimit {
  limited: boolean;
  resetAt?: string | null;
  message?: string;
}

export interface SetupAccount {
  login: string;
  type: 'user' | 'org';
  avatar_url: string;
}

export interface SetupRepo {
  name: string;
  nameWithOwner: string;
  description: string | null;
}
