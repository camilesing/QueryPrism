<script lang="ts" setup>
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  metadataSyncApi,
  type MetadataSyncAuth,
  type MetadataSyncRun,
  type MetadataSyncSource,
  type MetadataSyncUpsert,
  type SyncHttpMethod,
  type SyncKind,
  type SyncTarget,
} from '@/api/metadata-sync'

const { t } = useI18n()

const loading = ref(false)
const list = ref<MetadataSyncSource[]>([])
const runningId = ref<number | null>(null)

const search = () => {
  loading.value = true
  metadataSyncApi
    .list()
    .then((res) => {
      list.value = res || []
    })
    .finally(() => {
      loading.value = false
    })
}
onMounted(search)

const formatDate = (value?: string | null) => (value ? new Date(value).toLocaleString() : '-')
const statusTag = (status?: string | null) => {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'warning'
  return 'info'
}
const kindLabel = (kind: SyncKind) => t(`metadata_sync.kind_${kind}`)
const targetLabel = (target: SyncTarget) => t(`metadata_sync.target_${target}`)

// --- create / edit -------------------------------------------------------
const drawer = ref(false)
const saving = ref(false)
const formRef = ref()
const form = reactive({
  id: null as number | null,
  name: '',
  kind: 'HTTP_API' as SyncKind,
  target: 'semantic' as SyncTarget,
  endpoint: '',
  http_method: 'GET' as SyncHttpMethod,
  http_body: '',
  mcp_tool: '',
  mcp_args: '',
  cron: '',
  enabled: true,
  auth_token: '',
  auth_headers: '',
  clear_auth: false,
})
const rules = {
  name: [{ required: true, message: t('metadata_sync.name_required'), trigger: 'blur' }],
  endpoint: [{ required: true, message: t('metadata_sync.endpoint_required'), trigger: 'blur' }],
}

const resetForm = () => {
  form.id = null
  form.name = ''
  form.kind = 'HTTP_API'
  form.target = 'semantic'
  form.endpoint = ''
  form.http_method = 'GET'
  form.http_body = ''
  form.mcp_tool = ''
  form.mcp_args = ''
  form.cron = ''
  form.enabled = true
  form.auth_token = ''
  form.auth_headers = ''
  form.clear_auth = false
}

const openCreate = () => {
  resetForm()
  drawer.value = true
}

const openEdit = (row: MetadataSyncSource) => {
  resetForm()
  form.id = row.id
  form.name = row.name
  form.kind = row.kind
  form.target = row.target
  form.endpoint = row.endpoint
  form.http_method = row.http_method
  form.http_body = row.http_body ? JSON.stringify(row.http_body, null, 2) : ''
  form.mcp_tool = row.mcp_tool ?? ''
  form.mcp_args = row.mcp_args ? JSON.stringify(row.mcp_args, null, 2) : ''
  form.cron = row.cron ?? ''
  form.enabled = row.enabled
  // Existing credentials are never returned; leaving both blank keeps them.
  form.auth_token = ''
  form.auth_headers = ''
  form.clear_auth = false
  drawer.value = true
}

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(t('metadata_sync.invalid_json', { field: label }))
  }
}

const buildAuth = (): MetadataSyncAuth | null | undefined => {
  if (form.clear_auth) return null
  const auth: MetadataSyncAuth = {}
  if (form.auth_token.trim()) auth.token = form.auth_token.trim()
  if (form.auth_headers.trim()) {
    const parsed = parseJson(form.auth_headers, t('metadata_sync.auth_headers'))
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(t('metadata_sync.auth_headers_invalid'))
    }
    auth.headers = parsed as Record<string, string>
  }
  return auth.token || auth.headers ? auth : undefined
}

const save = () => {
  formRef.value
    ?.validate()
    .then(async (valid: boolean) => {
      if (!valid) return
      saving.value = true
      try {
        const isMcp = form.kind === 'MCP'
        const payload: MetadataSyncUpsert = {
          name: form.name.trim(),
          kind: form.kind,
          target: form.target,
          endpoint: form.endpoint.trim(),
          http_method: isMcp ? undefined : form.http_method,
          http_body: isMcp
            ? null
            : form.http_body.trim()
              ? parseJson(form.http_body, t('metadata_sync.http_body'))
              : null,
          mcp_tool: isMcp ? form.mcp_tool.trim() : null,
          mcp_args:
            isMcp && form.mcp_args.trim()
              ? (parseJson(form.mcp_args, t('metadata_sync.mcp_args')) as Record<string, unknown>)
              : null,
          cron: form.cron.trim() || null,
          enabled: form.enabled,
          auth: buildAuth(),
        }
        if (form.id) {
          await metadataSyncApi.update({ id: form.id, ...payload })
        } else {
          await metadataSyncApi.create(payload)
        }
        ElMessage.success(t('common.save_success'))
        drawer.value = false
        search()
      } catch (e) {
        ElMessage.error(e instanceof Error ? e.message : String(e))
      } finally {
        saving.value = false
      }
    })
    .catch(() => undefined)
}

const remove = (row: MetadataSyncSource) => {
  ElMessageBox.confirm(t('metadata_sync.delete_confirm', { name: row.name }), {
    confirmButtonText: t('metadata_sync.delete'),
    cancelButtonText: t('common.cancel'),
    type: 'warning',
  })
    .then(() => metadataSyncApi.remove(row.id))
    .then(() => {
      ElMessage.success(t('metadata_sync.deleted'))
      search()
    })
    .catch(() => undefined)
}

const run = (row: MetadataSyncSource) => {
  runningId.value = row.id
  metadataSyncApi
    .run(row.id)
    .then((res) => {
      if (res.status === 'success') {
        ElMessage.success(
          t('metadata_sync.run_success', {
            applied: res.applied,
            failed: res.failed_count,
          })
        )
      } else {
        ElMessage.error(
          t('metadata_sync.run_failed', {
            applied: res.applied,
            failed: res.failed_count,
          })
        )
      }
      search()
    })
    .finally(() => {
      runningId.value = null
    })
}

// --- run history ---------------------------------------------------------
const runsDrawer = ref(false)
const runsLoading = ref(false)
const runsSource = ref<MetadataSyncSource | null>(null)
const runs = ref<MetadataSyncRun[]>([])
const runsTotal = ref(0)
const runsPage = ref(1)
const runsPageSize = 20

const loadRuns = () => {
  if (!runsSource.value) return
  runsLoading.value = true
  metadataSyncApi
    .runs(runsSource.value.id, runsPage.value, runsPageSize)
    .then((res) => {
      runs.value = res?.data || []
      runsTotal.value = res?.total_count || 0
    })
    .finally(() => {
      runsLoading.value = false
    })
}

const openRuns = (row: MetadataSyncSource) => {
  runsSource.value = row
  runsPage.value = 1
  runs.value = []
  runsDrawer.value = true
  loadRuns()
}

const changeRunsPage = (page: number) => {
  runsPage.value = page
  loadRuns()
}
</script>

<template>
  <div v-loading="loading" class="metadata-sync">
    <div class="toolbar">
      <div>
        <div class="page-title">{{ t('metadata_sync.title') }}</div>
        <div class="page-subtitle">{{ t('metadata_sync.subtitle') }}</div>
      </div>
      <el-button type="primary" @click="openCreate">
        {{ t('metadata_sync.create') }}
      </el-button>
    </div>

    <el-table :data="list" row-key="id" :empty-text="t('metadata_sync.empty')">
      <el-table-column prop="name" :label="t('metadata_sync.name')" min-width="150" />
      <el-table-column :label="t('metadata_sync.kind')" width="110">
        <template #default="{ row }">
          <el-tag>{{ kindLabel(row.kind) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('metadata_sync.target')" width="120">
        <template #default="{ row }">
          <el-tag type="info">{{ targetLabel(row.target) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="endpoint"
        :label="t('metadata_sync.endpoint')"
        min-width="220"
        show-overflow-tooltip
      />
      <el-table-column :label="t('metadata_sync.cron')" width="130">
        <template #default="{ row }">
          {{ row.cron || t('metadata_sync.manual_only') }}
        </template>
      </el-table-column>
      <el-table-column :label="t('metadata_sync.enabled')" width="100">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">
            {{ row.enabled ? t('metadata_sync.enabled_yes') : t('metadata_sync.enabled_no') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('metadata_sync.last_run')" min-width="190">
        <template #default="{ row }">
          <el-tag v-if="row.last_status" :type="statusTag(row.last_status)" size="small">
            {{ row.last_status }}
          </el-tag>
          <span class="last-run">{{ formatDate(row.last_run_at) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('metadata_sync.actions')" width="290" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :loading="runningId === row.id" @click="run(row)">
            {{ t('metadata_sync.run_now') }}
          </el-button>
          <el-button link @click="openRuns(row)">
            {{ t('metadata_sync.history') }}
          </el-button>
          <el-button link type="primary" @click="openEdit(row)">
            {{ t('metadata_sync.edit') }}
          </el-button>
          <el-button link type="danger" @click="remove(row)">
            {{ t('metadata_sync.delete') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- create / edit -->
    <el-drawer
      v-model="drawer"
      :title="form.id ? t('metadata_sync.edit') : t('metadata_sync.create')"
      size="520px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item prop="name" :label="t('metadata_sync.name')">
          <el-input v-model="form.name" :placeholder="t('metadata_sync.name_required')" />
        </el-form-item>
        <el-form-item :label="t('metadata_sync.kind')">
          <el-radio-group v-model="form.kind">
            <el-radio-button value="HTTP_API">{{ kindLabel('HTTP_API') }}</el-radio-button>
            <el-radio-button value="MCP">{{ kindLabel('MCP') }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('metadata_sync.target')">
          <el-select v-model="form.target" style="width: 100%">
            <el-option value="semantic" :label="targetLabel('semantic')" />
            <el-option value="metric" :label="targetLabel('metric')" />
            <el-option value="standard" :label="targetLabel('standard')" />
          </el-select>
        </el-form-item>
        <el-form-item prop="endpoint" :label="t('metadata_sync.endpoint')">
          <el-input
            v-model="form.endpoint"
            :placeholder="t('metadata_sync.endpoint_placeholder')"
          />
        </el-form-item>

        <template v-if="form.kind === 'HTTP_API'">
          <el-form-item :label="t('metadata_sync.http_method')">
            <el-radio-group v-model="form.http_method">
              <el-radio-button value="GET">GET</el-radio-button>
              <el-radio-button value="POST">POST</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="form.http_method === 'POST'" :label="t('metadata_sync.http_body')">
            <el-input
              v-model="form.http_body"
              type="textarea"
              :rows="4"
              :placeholder="t('metadata_sync.json_placeholder')"
            />
          </el-form-item>
        </template>

        <template v-else>
          <el-form-item :label="t('metadata_sync.mcp_tool')">
            <el-input
              v-model="form.mcp_tool"
              :placeholder="t('metadata_sync.mcp_tool_placeholder')"
            />
          </el-form-item>
          <el-form-item :label="t('metadata_sync.mcp_args')">
            <el-input
              v-model="form.mcp_args"
              type="textarea"
              :rows="4"
              :placeholder="t('metadata_sync.json_placeholder')"
            />
          </el-form-item>
        </template>

        <el-divider content-position="left">{{ t('metadata_sync.auth') }}</el-divider>
        <el-form-item :label="t('metadata_sync.auth_token')">
          <el-input
            v-model="form.auth_token"
            type="password"
            show-password
            :placeholder="
              form.id && !form.clear_auth
                ? t('metadata_sync.auth_keep_placeholder')
                : t('metadata_sync.auth_token_placeholder')
            "
          />
        </el-form-item>
        <el-form-item :label="t('metadata_sync.auth_headers')">
          <el-input
            v-model="form.auth_headers"
            type="textarea"
            :rows="3"
            :placeholder="t('metadata_sync.auth_headers_placeholder')"
          />
        </el-form-item>
        <el-form-item v-if="form.id">
          <el-checkbox v-model="form.clear_auth">
            {{ t('metadata_sync.clear_auth') }}
          </el-checkbox>
        </el-form-item>

        <el-form-item :label="t('metadata_sync.cron')">
          <el-input v-model="form.cron" :placeholder="t('metadata_sync.cron_placeholder')" />
          <div class="field-hint">{{ t('metadata_sync.cron_hint') }}</div>
        </el-form-item>
        <el-form-item :label="t('metadata_sync.enabled')">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="drawer = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">
          {{ t('common.save') }}
        </el-button>
      </template>
    </el-drawer>

    <!-- run history -->
    <el-drawer
      v-model="runsDrawer"
      :title="t('metadata_sync.runs_title', { name: runsSource?.name || '' })"
      size="720px"
    >
      <div v-loading="runsLoading">
        <el-empty v-if="!runs.length" :description="t('metadata_sync.no_runs')" />
        <el-table v-else :data="runs" row-key="id">
          <el-table-column type="expand">
            <template #default="{ row }">
              <pre class="run-detail">{{
                JSON.stringify({ error: row.error, failed: row.failed }, null, 2)
              }}</pre>
            </template>
          </el-table-column>
          <el-table-column prop="started_at" :label="t('metadata_sync.started_at')" width="180">
            <template #default="{ row }">{{ formatDate(row.started_at) }}</template>
          </el-table-column>
          <el-table-column :label="t('metadata_sync.trigger')" width="100">
            <template #default="{ row }">{{ t(`metadata_sync.trigger_${row.trigger}`) }}</template>
          </el-table-column>
          <el-table-column :label="t('metadata_sync.status')" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status)" size="small">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="applied" :label="t('metadata_sync.applied')" width="90" />
          <el-table-column
            prop="failed_count"
            :label="t('metadata_sync.failed_count')"
            width="90"
          />
          <el-table-column
            prop="error"
            :label="t('metadata_sync.error')"
            min-width="180"
            show-overflow-tooltip
          />
        </el-table>
        <el-pagination
          v-if="runsTotal > runsPageSize"
          class="pager"
          layout="prev, pager, next"
          :total="runsTotal"
          :page-size="runsPageSize"
          :current-page="runsPage"
          @current-change="changeRunsPage"
        />
      </div>
    </el-drawer>
  </div>
</template>

<style lang="less" scoped>
.metadata-sync {
  padding: 20px 24px;
  background: #fff;
  border-radius: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.page-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.last-run {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.field-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}
.run-detail {
  max-height: 280px;
  margin: 0;
  padding: 8px 16px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
}
.pager {
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
