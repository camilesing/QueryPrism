<script lang="ts" setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus-secondary'
import {
  regressionApi,
  type RegressionCaseRow,
  type RegressionRunCaseRow,
  type RegressionRunRow,
} from '@/api/regression'
import { datasourceApi } from '@/api/datasource'

const { t } = useI18n()

// Dialog/drawer sizes are JS-driven (Element Plus takes them as props), so the
// page also reacts to window resizes from a desktop layout.
const isNarrow = ref(window.innerWidth < 768)
const syncNarrow = () => {
  isNarrow.value = window.innerWidth < 768
}

// --- cases ---------------------------------------------------------------
const loading = ref(false)
const cases = ref<RegressionCaseRow[]>([])
const datasources = ref<Array<{ id: number; name: string }>>([])
const casePage = reactive({ currentPage: 1, pageSize: 20, total: 0 })

const searchCases = (page = 1) => {
  loading.value = true
  regressionApi
    .cases({ current_page: page, page_size: casePage.pageSize })
    .then((res) => {
      cases.value = res?.rows || []
      casePage.currentPage = page
      casePage.total = res?.total || 0
    })
    .finally(() => {
      loading.value = false
    })
}

const dsName = (id: number) => datasources.value.find((d) => d.id === id)?.name ?? `#${id}`

const statusTag = (status: string) => {
  if (status === 'passed' || status === 'baseline_captured') return 'success'
  if (status === 'flagged') return 'danger'
  if (status === 'needs_clarify') return 'warning'
  return 'info'
}
const statusLabel = (status: string) => t(`regression.status_${status}`)

const formatDate = (value?: string | null) => (value ? new Date(value).toLocaleString() : '-')

// --- case dialog ---------------------------------------------------------
const dialog = ref(false)
const saving = ref(false)
const formRef = ref()
const form = reactive({
  id: null as number | null,
  datasource_id: null as number | null,
  name: '',
  question: '',
  metric_code: '',
  tolerance_pct: 10,
  enabled: true,
})
const rules = {
  datasource_id: [
    { required: true, message: t('regression.datasource_required'), trigger: 'change' },
  ],
  name: [{ required: true, message: t('regression.name_required'), trigger: 'blur' }],
  question: [{ required: true, message: t('regression.question_required'), trigger: 'blur' }],
}

const openCreate = () => {
  form.id = null
  form.datasource_id = datasources.value[0]?.id ?? null
  form.name = ''
  form.question = ''
  form.metric_code = ''
  form.tolerance_pct = 10
  form.enabled = true
  dialog.value = true
}
const openEdit = (row: RegressionCaseRow) => {
  form.id = row.id
  form.datasource_id = row.datasourceId
  form.name = row.name
  form.question = row.question
  form.metric_code = row.metricCode ?? ''
  form.tolerance_pct = row.tolerancePct
  form.enabled = row.enabled
  dialog.value = true
}

const save = () => {
  formRef.value?.validate((valid: boolean) => {
    if (!valid) return
    saving.value = true
    regressionApi
      .upsertCase({
        id: form.id ?? undefined,
        datasource_id: form.datasource_id!,
        name: form.name,
        question: form.question,
        metric_code: form.metric_code || null,
        tolerance_pct: form.tolerance_pct,
        enabled: form.enabled,
      })
      .then(() => {
        ElMessage.success(t('regression.saved'))
        dialog.value = false
        searchCases()
        searchRuns()
      })
      .finally(() => {
        saving.value = false
      })
  })
}

const removeCase = (row: RegressionCaseRow) => {
  ElMessageBox.confirm(
    t('regression.remove_confirm', { name: row.name }),
    t('regression.confirm_title'),
    { type: 'warning' }
  )
    .then(() => regressionApi.removeCase(row.id))
    .then(() => {
      ElMessage.success(t('regression.removed'))
      searchCases()
    })
    .catch(() => undefined)
}

const toggleCase = (row: RegressionCaseRow) => {
  regressionApi
    .setCaseEnabled(row.id, !row.enabled)
    .then(() => searchCases())
    .catch(() => undefined)
}

// --- runs ----------------------------------------------------------------
const runsLoading = ref(false)
const runs = ref<RegressionRunRow[]>([])
const running = ref(false)
const runPage = reactive({ currentPage: 1, pageSize: 20, total: 0 })

const searchRuns = (page = 1) => {
  runsLoading.value = true
  regressionApi
    .runs({ current_page: page, page_size: runPage.pageSize })
    .then((res) => {
      runs.value = res?.rows || []
      runPage.currentPage = page
      runPage.total = res?.total || 0
    })
    .finally(() => {
      runsLoading.value = false
    })
}

const refreshAll = () => {
  searchCases(casePage.currentPage)
  searchRuns(runPage.currentPage)
}

const runNow = () => {
  running.value = true
  regressionApi
    .run()
    .then(() => {
      ElMessage.success(t('regression.run_started'))
      // The run executes in the background — refresh shortly + pollable by hand.
      setTimeout(searchRuns, 1500)
      setTimeout(searchRuns, 5000)
    })
    .finally(() => {
      running.value = false
    })
}

const promote = (row: RegressionRunRow) => {
  ElMessageBox.confirm(t('regression.promote_confirm'), t('regression.confirm_title'), {
    type: 'warning',
  })
    .then(() => regressionApi.promote(row.id))
    .then((res) => {
      ElMessage.success(t('regression.promoted', { count: res?.promoted ?? 0 }))
      searchCases()
    })
    .catch(() => undefined)
}

// --- run detail drawer ---------------------------------------------------
const detailDrawer = ref(false)
const detailLoading = ref(false)
const detailRun = ref<RegressionRunRow | null>(null)
const detailCases = ref<RegressionRunCaseRow[]>([])

const openDetail = (row: RegressionRunRow) => {
  detailRun.value = row
  detailDrawer.value = true
  detailLoading.value = true
  regressionApi
    .runDetail(row.id)
    .then((res) => {
      detailCases.value = res?.cases || []
    })
    .finally(() => {
      detailLoading.value = false
    })
}

const reasonLabel = (reason: string) => {
  const [kind, col] = reason.split(':')
  return col ? t(`regression.reason_${kind}`, { col }) : t(`regression.reason_${kind}`)
}

const deltaText = (rc: RegressionRunCaseRow) => {
  if (!rc.delta || rc.status === 'baseline_captured') return '-'
  const parts: string[] = []
  if (rc.delta.rowCountPct != null)
    parts.push(`${t('regression.row_count')} ${rc.delta.rowCountPct.toFixed(1)}%`)
  for (const [col, pct] of Object.entries(rc.delta.sums)) parts.push(`${col} ${pct.toFixed(1)}%`)
  // LLM alias drift the comparison forgave — shown so the names here can be
  // matched against the run's SQL despite the rename.
  for (const r of rc.delta.renamedColumns ?? []) parts.push(`${r.from} → ${r.to}`)
  return parts.join(' / ')
}

onMounted(() => {
  window.addEventListener('resize', syncNarrow)
  datasourceApi
    .list()
    .then((res: any) => {
      datasources.value = (res || []).map((d: any) => ({ id: d.id, name: d.name }))
    })
    .catch(() => undefined)
  searchCases()
  searchRuns()
})

onUnmounted(() => {
  window.removeEventListener('resize', syncNarrow)
})
</script>

<template>
  <div class="page-container">
    <div class="toolbar">
      <h2 class="page-title">{{ t('regression.menu_title') }}</h2>
      <el-space wrap class="toolbar-actions">
        <el-button type="primary" @click="openCreate">{{ t('regression.create_case') }}</el-button>
        <el-button type="warning" :loading="running" @click="runNow">
          {{ t('regression.run_now') }}
        </el-button>
        <el-button :loading="loading" @click="refreshAll">
          {{ t('regression.refresh') }}
        </el-button>
      </el-space>
    </div>
    <p class="page-hint">{{ t('regression.hint') }}</p>

    <h3 class="section-title">{{ t('regression.cases') }}</h3>
    <div class="table-scroll">
      <el-table v-loading="loading" :data="cases" border class="data-table">
        <el-table-column prop="name" :label="t('regression.case_name')" min-width="120" />
        <el-table-column
          prop="question"
          :label="t('regression.question')"
          min-width="220"
          show-overflow-tooltip
        />
        <el-table-column :label="t('regression.datasource')" min-width="110" show-overflow-tooltip>
          <template #default="{ row }">{{ dsName(row.datasourceId) }}</template>
        </el-table-column>
        <el-table-column
          prop="tolerancePct"
          :label="t('regression.tolerance')"
          width="88"
          align="center"
        />
        <el-table-column :label="t('regression.baseline')" min-width="170">
          <template #default="{ row }">
            <span v-if="row.baseline">
              {{ t('regression.baseline_at', { time: formatDate(row.baseline.capturedAt) }) }}
            </span>
            <span v-else>{{ t('regression.no_baseline') }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('regression.status')" width="80" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleCase(row)" />
          </template>
        </el-table-column>
        <el-table-column :label="t('regression.operations')" width="140">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">{{
              t('regression.edit')
            }}</el-button>
            <el-button link type="danger" @click="removeCase(row)">{{
              t('regression.delete')
            }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-pagination
      v-model:current-page="casePage.currentPage"
      class="pagination"
      :page-size="casePage.pageSize"
      :total="casePage.total"
      layout="total, prev, pager, next"
      @current-change="(p: number) => searchCases(p)"
    />

    <h3 class="section-title">{{ t('regression.runs') }}</h3>
    <div class="table-scroll">
      <el-table v-loading="runsLoading" :data="runs" border class="data-table">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column :label="t('regression.trigger')" width="110">
          <template #default="{ row }">{{ t(`regression.trigger_${row.trigger}`) }}</template>
        </el-table-column>
        <el-table-column :label="t('regression.run_status')" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'done' ? 'success' : 'warning'" size="small">
              {{ row.status === 'done' ? t('regression.run_done') : t('regression.run_running') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('regression.summary')" min-width="230">
          <template #default="{ row }">
            <el-tag type="success" size="small"
              >{{ t('regression.passed') }}: {{ row.passed }}</el-tag
            >
            <el-tag type="danger" size="small" class="tag-gap"
              >{{ t('regression.flagged') }}: {{ row.flagged }}</el-tag
            >
            <el-tag type="info" size="small" class="tag-gap"
              >{{ t('regression.errored') }}: {{ row.errored }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column :label="t('regression.started_at')" min-width="170">
          <template #default="{ row }">{{ formatDate(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column :label="t('regression.operations')" width="160">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">{{
              t('regression.detail')
            }}</el-button>
            <el-button v-if="row.status === 'done'" link type="warning" @click="promote(row)">
              {{ t('regression.promote') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-pagination
      v-model:current-page="runPage.currentPage"
      class="pagination"
      :page-size="runPage.pageSize"
      :total="runPage.total"
      layout="total, prev, pager, next"
      @current-change="(p: number) => searchRuns(p)"
    />

    <el-dialog
      v-model="dialog"
      :title="t('regression.create_case')"
      :width="isNarrow ? '92%' : '620px'"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="120px"
        :label-position="isNarrow ? 'top' : 'right'"
      >
        <el-form-item :label="t('regression.datasource')" prop="datasource_id">
          <el-select v-model="form.datasource_id" style="width: 100%">
            <el-option v-for="d in datasources" :key="d.id" :value="d.id" :label="d.name" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('regression.case_name')" prop="name">
          <el-input v-model="form.name" :placeholder="t('regression.name_placeholder')" />
        </el-form-item>
        <el-form-item :label="t('regression.question')" prop="question">
          <el-input
            v-model="form.question"
            type="textarea"
            :rows="2"
            :placeholder="t('regression.question_placeholder')"
          />
        </el-form-item>
        <el-form-item :label="t('regression.metric_code')">
          <el-input
            v-model="form.metric_code"
            :placeholder="t('regression.metric_code_placeholder')"
          />
        </el-form-item>
        <el-form-item :label="t('regression.tolerance')">
          <el-input-number v-model="form.tolerance_pct" :min="0" :max="100" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ t('regression.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{
          t('regression.confirm')
        }}</el-button>
      </template>
    </el-dialog>

    <el-drawer
      v-model="detailDrawer"
      :title="t('regression.detail')"
      :size="isNarrow ? '100%' : '70%'"
    >
      <div class="table-scroll">
        <el-table
          v-loading="detailLoading"
          :data="detailCases"
          border
          class="data-table detail-table"
        >
          <el-table-column :label="t('regression.case_name')" min-width="130">
            <template #default="{ row }">{{ row.case?.name ?? `#${row.caseId}` }}</template>
          </el-table-column>
          <el-table-column :label="t('regression.run_status')" width="130">
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status)" size="small">{{
                statusLabel(row.status)
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('regression.row_count')" width="90" align="right">
            <template #default="{ row }">{{ row.rowCount ?? '-' }}</template>
          </el-table-column>
          <el-table-column :label="t('regression.delta')" min-width="200">
            <template #default="{ row }">{{ deltaText(row) }}</template>
          </el-table-column>
          <el-table-column :label="t('regression.reasons')" min-width="180">
            <template #default="{ row }">
              <el-tag
                v-for="r in row.delta?.reasons ?? []"
                :key="r"
                type="danger"
                size="small"
                class="tag-gap"
              >
                {{ reasonLabel(r) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('regression.sql')" min-width="260">
            <template #default="{ row }">
              <el-tooltip v-if="row.sql" :content="row.sql" placement="top" :show-after="300">
                <span class="sql-cell">{{ row.sql }}</span>
              </el-tooltip>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('regression.message')" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ row.message ?? '-' }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.page-container {
  padding: 16px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.page-title {
  margin: 0;
  font-size: 16px;
  white-space: nowrap;
}
.toolbar-actions {
  margin-left: auto;
}
.page-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
  margin: 8px 0 12px;
}
.section-title {
  margin: 20px 0 10px;
  font-size: 14px;
}
/* Element Plus tables shrink columns until they are unusable; give the table
   its natural width and let this wrapper scroll on narrow viewports instead. */
.table-scroll {
  width: 100%;
  overflow-x: auto;
}
.data-table {
  min-width: 940px;
}
/* The theme gives every button an 80px min-width; link buttons in table cells
   only need their text width, otherwise "edit / delete" wrap onto two lines. */
.table-scroll :deep(.ed-button.is-link) {
  min-width: 0;
}
.detail-table {
  min-width: 1150px;
}
.pagination {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 8px;
  margin: 12px 0 0;
}
.tag-gap {
  margin-left: 4px;
}
.sql-cell {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  font-family: monospace;
  font-size: 12px;
}
@media (max-width: 768px) {
  .page-container {
    padding: 12px;
  }
  .toolbar {
    align-items: flex-start;
  }
  .toolbar-actions {
    width: 100%;
    margin-left: 0;
  }
  .toolbar-actions :deep(.el-space__item) {
    flex: 1 1 auto;
  }
  .toolbar-actions :deep(.el-button) {
    width: 100%;
    margin-left: 0;
  }
  .pagination {
    justify-content: center;
  }
  .section-title {
    margin-top: 16px;
  }
}
</style>
