<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus-secondary'
import {
  metricApi,
  standardApi,
  type ChangeRequestRow,
  type MetricKind,
  type MetricRow,
  type SemanticScope,
  type StandardKind,
  type StandardRow,
  type VersionRow,
} from '@/api/metric'
import { datasourceApi } from '@/api/datasource'
import { request } from '@/utils/request'
import { splitAliases } from '@/utils/utils'
import EmptyBackground from '@/views/dashboard/common/EmptyBackground.vue'
import icon_add_outlined from '@/assets/svg/icon_add_outlined.svg'
import IconOpeEdit from '@/assets/svg/icon_edit_outlined.svg'
import IconOpeDelete from '@/assets/svg/icon_delete.svg'
import icon_searchOutline_outlined from '@/assets/svg/icon_search-outline_outlined.svg'

/** MetaDataImprove M4 — metric system admin page: atomic metrics, modifiers,
 *  time periods, derived metrics, composite metrics and the data standards
 *  (units + naming dictionary) on the M2 governance stack (3-layer scope,
 *  cross-layer approval inbox, per-entry version history). */
const { t } = useI18n()

type Tab = MetricKind | 'standard' | 'approval'
const activeTab = ref<Tab>('atomic')
const loading = ref(false)
const rows = ref<Array<MetricRow | StandardRow>>([])
const datasources = ref<Array<{ id: number; name: string }>>([])
const scopeFilter = ref<'' | SemanticScope>('')
const keyword = ref('')
const dsFilter = ref<number | undefined>(undefined)
const pageInfo = reactive({ currentPage: 1, pageSize: 10, total: 0 })

/** The data-standard tab's inner kind switch (unit | naming). */
const stdKind = ref<StandardKind>('naming')

const isMetricTab = computed(() => activeTab.value !== 'standard' && activeTab.value !== 'approval')
const metricKind = computed(() => activeTab.value as MetricKind)

const scopeOptions = [
  { value: 'GLOBAL', label: () => t('metric.scope_global') },
  { value: 'WORKSPACE', label: () => t('metric.scope_workspace') },
  { value: 'PERSONAL', label: () => t('metric.scope_personal') },
]
const scopeLabel = (scope: string) => scopeOptions.find((s) => s.value === scope)?.label() ?? scope

const aggregationOptions = ['SUM', 'COUNT', 'COUNT_DISTINCT', 'AVG', 'MAX', 'MIN'].map((v) => ({
  value: v,
  label: () => t(`metric.agg_${v.toLowerCase()}`),
}))
const operatorOptions = [
  '=',
  '!=',
  'in',
  'not_in',
  'like',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
].map((v) => ({
  value: v,
  label: () =>
    t(
      `metric.op_${{ '=': 'eq', '!=': 'neq', in: 'in', not_in: 'not_in', like: 'like', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', between: 'between' }[v]}`
    ),
}))
const timeUnitOptions = ['day', 'week', 'month', 'quarter', 'year'].map((v) => ({
  value: v,
  label: () => t(`metric.unit_${v}`),
}))
const anchorOptions = ['yesterday', 'today', 'wtd', 'mtd', 'qtd', 'ytd'].map((v) => ({
  value: v,
  label: () => t(`metric.anchor_${v}`),
}))
const unitCategoryOptions = ['currency', 'count', 'time', 'other'].map((v) => ({
  value: v,
  label: () => t(`metric.category_unit_${v}`),
}))
const namingCategoryOptions = ['business_noun', 'table_root', 'field_root'].map((v) => ({
  value: v,
  label: () => t(`metric.category_naming_${v}`),
}))

const dsName = (id: number) => datasources.value.find((d) => d.id === id)?.name ?? `#${id}`

function search(page = 1) {
  loading.value = true
  const done = (res: { data: typeof rows.value; current_page: number; total_count: number }) => {
    rows.value = res.data ?? []
    pageInfo.currentPage = res.current_page
    pageInfo.total = res.total_count
  }
  if (activeTab.value === 'standard') {
    standardApi
      .page(stdKind.value, page, pageInfo.pageSize, {
        scope: scopeFilter.value || undefined,
        keyword: keyword.value || undefined,
      })
      .then(done)
      .finally(() => (loading.value = false))
    return
  }
  metricApi
    .page(metricKind.value, page, pageInfo.pageSize, {
      scope: scopeFilter.value || undefined,
      datasource_id: dsFilter.value,
      keyword: keyword.value || undefined,
    })
    .then(done)
    .finally(() => (loading.value = false))
}

function switchTab(tab: string | number) {
  if (tab === 'approval') searchRequests()
  else search(1)
}

onMounted(() => {
  datasourceApi.list().then((res: any) => {
    datasources.value = [...res]
  })
  search()
})

/** Human-readable one-line definition summary for the list column. */
function defSummary(row: MetricRow | StandardRow): string {
  const d = ('definition' in row ? row.definition : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (row.kind) {
    case 'atomic':
      return `${dsName(Number(d.datasource_id))}: ${str(d.aggregation)}(${str(d.table_name)}.${str(d.field_name)})`
    case 'modifier':
      return `${dsName(Number(d.datasource_id))}: ${str(d.table_name)}.${str(d.field_name)} ${str(d.operator)} (${(Array.isArray(d.values) ? d.values : []).join(', ')})`
    case 'period':
      return str(d.mode) === 'anchor'
        ? t(`metric.anchor_${str(d.anchor)}`)
        : `${t('metric.mode_recent')}${d.count}${t(`metric.unit_${str(d.time_unit)}`)}`
    case 'derived': {
      const mods = Array.isArray(d.modifier_codes) ? d.modifier_codes.join(', ') : ''
      return `${t('metric.atomic_code')}: ${str(d.atomic_code)}${mods ? `; ${t('metric.tab_modifier')}: ${mods}` : ''}${str(d.period_code) ? `; ${t('metric.tab_period')}: ${str(d.period_code)}` : ''}`
    }
    case 'composite':
      return str(d.expression)
    case 'unit':
    case 'naming':
      return `${(row as StandardRow).term} → ${(row as StandardRow).name}`
    default:
      return ''
  }
}

// ---- create / edit dialog ------------------------------------------------

const dialogVisible = ref(false)
const saving = ref(false)
const defaultForm = () => ({
  id: null as number | null,
  scope: 'WORKSPACE' as SemanticScope,
  code: '',
  name: '',
  aliasesText: '',
  description: '',
  note: '',
  // atomic / modifier
  datasource_id: undefined as number | undefined,
  table_name: '',
  field_name: '',
  aggregation: 'SUM',
  unit: '',
  operator: '=',
  valuesText: '',
  // period
  mode: 'recent',
  time_unit: 'day',
  count: 7,
  anchor: 'yesterday',
  // derived
  atomic_code: '',
  modifier_codesText: '',
  period_code: '',
  time_field: '',
  // composite
  expression: '',
  // data standard
  term: '',
  standard_name: '',
  category: '',
})
const form = reactive(defaultForm())

function openCreate() {
  Object.assign(form, defaultForm())
  if (dsFilter.value) form.datasource_id = dsFilter.value
  if (activeTab.value === 'standard')
    form.category = stdKind.value === 'unit' ? 'other' : 'business_noun'
  dialogVisible.value = true
}

function openEdit(row: MetricRow | StandardRow) {
  Object.assign(form, defaultForm(), {
    id: row.id,
    scope: row.scope,
    code: row.code,
    name: row.name,
    aliasesText: (row.aliases ?? []).join(', '),
    description: row.description ?? '',
    note: '',
  })
  if (!('definition' in row)) {
    form.term = row.term
    form.standard_name = row.name
  }
  if ('definition' in row) {
    const d = row.definition as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    if (row.kind === 'atomic' || row.kind === 'modifier') {
      form.datasource_id = Number(d.datasource_id) || undefined
      form.table_name = str(d.table_name)
      form.field_name = str(d.field_name)
    }
    if (row.kind === 'atomic') {
      form.aggregation = str(d.aggregation) || 'SUM'
      form.unit = row.unit ?? ''
    }
    if (row.kind === 'modifier') {
      form.operator = str(d.operator) || '='
      form.valuesText = (Array.isArray(d.values) ? (d.values as unknown[]) : [])
        .map((v) => String(v))
        .join('\n')
    }
    if (row.kind === 'period') {
      form.mode = str(d.mode) || 'recent'
      form.time_unit = str(d.time_unit) || 'day'
      form.count = Number(d.count) || 7
      form.anchor = str(d.anchor) || 'yesterday'
    }
    if (row.kind === 'derived') {
      form.atomic_code = str(d.atomic_code)
      form.modifier_codesText = (
        Array.isArray(d.modifier_codes) ? (d.modifier_codes as unknown[]) : []
      )
        .map((v) => String(v))
        .join(', ')
      form.period_code = str(d.period_code)
      form.time_field = str(d.time_field)
    }
    if (row.kind === 'composite') form.expression = str(d.expression)
  } else {
    form.category = row.category ?? ''
  }
  dialogVisible.value = true
}

function submitForm() {
  // The data-standard form fills `term` + `standard_name` instead of `name`
  // (checked in its own branch below); the generic check must not run there,
  // or no standard can ever be created from this page.
  if (activeTab.value !== 'standard' && (!form.code.trim() || !form.name.trim())) {
    ElMessage.error(t('metric.form_required'))
    return
  }
  let payload: Record<string, unknown>
  if (activeTab.value === 'standard') {
    if (!form.code.trim() || !form.term.trim() || !form.standard_name.trim()) {
      ElMessage.error(t('metric.form_required'))
      return
    }
    payload = {
      kind: stdKind.value,
      scope: form.scope,
      code: form.code.trim(),
      term: form.term.trim(),
      name: form.standard_name.trim(),
      note: form.note.trim() || undefined,
    }
    // Always send aliases (including []) so clearing the field clears the
    // stored list instead of leaving the old aliases matching questions.
    payload.aliases = splitAliases(form.aliasesText)
    if (form.category.trim()) payload.category = form.category.trim()
    if (form.description.trim()) payload.description = form.description.trim()
    saving.value = true
    standardApi
      .upsert(payload)
      .then(onSaved)
      .finally(() => (saving.value = false))
    return
  }
  const aliases = splitAliases(form.aliasesText)
  payload = {
    kind: metricKind.value,
    scope: form.scope,
    code: form.code.trim(),
    name: form.name.trim(),
    note: form.note.trim() || undefined,
  }
  // Always send aliases (including []) so clearing the field clears the stored
  // list instead of leaving the old aliases matching questions.
  payload.aliases = aliases
  if (form.description.trim()) payload.description = form.description.trim()
  switch (metricKind.value) {
    case 'atomic':
      if (!form.datasource_id || !form.table_name.trim() || !form.field_name.trim()) {
        ElMessage.error(t('metric.form_required'))
        return
      }
      if (form.unit.trim()) payload.unit = form.unit.trim()
      payload.definition = {
        datasource_id: form.datasource_id,
        table_name: form.table_name.trim(),
        field_name: form.field_name.trim(),
        aggregation: form.aggregation,
      }
      break
    case 'modifier': {
      const values = splitAliases(form.valuesText)
      if (
        !form.datasource_id ||
        !form.table_name.trim() ||
        !form.field_name.trim() ||
        values.length === 0
      ) {
        ElMessage.error(t('metric.form_required'))
        return
      }
      payload.definition = {
        datasource_id: form.datasource_id,
        table_name: form.table_name.trim(),
        field_name: form.field_name.trim(),
        operator: form.operator,
        values,
      }
      break
    }
    case 'period':
      payload.definition =
        form.mode === 'anchor'
          ? { mode: 'anchor', anchor: form.anchor }
          : { mode: 'recent', time_unit: form.time_unit, count: form.count }
      break
    case 'derived':
      if (!form.atomic_code.trim()) {
        ElMessage.error(t('metric.form_required'))
        return
      }
      payload.definition = {
        atomic_code: form.atomic_code.trim(),
        ...(splitAliases(form.modifier_codesText).length > 0
          ? { modifier_codes: splitAliases(form.modifier_codesText) }
          : {}),
        ...(form.period_code.trim() ? { period_code: form.period_code.trim() } : {}),
        ...(form.time_field.trim() ? { time_field: form.time_field.trim() } : {}),
      }
      break
    case 'composite':
      if (!form.expression.trim()) {
        ElMessage.error(t('metric.form_required'))
        return
      }
      payload.definition = { expression: form.expression.trim() }
      break
  }
  saving.value = true
  metricApi
    .upsert(payload)
    .then(onSaved)
    .finally(() => (saving.value = false))
}

function onSaved(res: { applied: boolean }) {
  if (!res.applied) {
    // Lower-layer proposal → waiting for the layer admin's approval.
    ElMessage.success(t('metric.proposed_hint'))
  } else {
    ElMessage.success(t('common.save_success'))
  }
  dialogVisible.value = false
  search(pageInfo.currentPage)
}

// ---- remove / toggle / excel ----------------------------------------------

const selection = ref<Array<MetricRow | StandardRow>>([])

function removeRows(target?: Array<MetricRow | StandardRow>) {
  const victims = target ?? selection.value
  if (victims.length === 0) return
  ElMessageBox.confirm(t('metric.delete_hint', [victims.length]), {
    confirmButtonType: 'primary',
    confirmButtonText: t('common.confirm2'),
    cancelButtonText: t('common.cancel'),
    customClass: 'confirm-no_icon',
    autofocus: false,
  }).then(() => {
    const ids = victims.map((r) => r.id)
    const done = (res: { removed: number; requested: number }) => {
      if (res.requested > 0) ElMessage.success(t('metric.proposed_hint'))
      search(pageInfo.currentPage)
    }
    if (activeTab.value === 'standard') standardApi.remove(ids).then(done)
    else metricApi.remove(ids).then(done)
  })
}

function toggleEnabled(row: MetricRow | StandardRow, enabled: boolean) {
  const done = () => (row.enabled = enabled)
  if (activeTab.value === 'standard') standardApi.setEnabled(row.id, enabled).then(done)
  else metricApi.setEnabled(row.id, enabled).then(done)
}

const importInput = ref()

function exportExcel() {
  request
    .get('/system/metric/export', {
      responseType: 'blob',
      requestOptions: { customError: true },
    } as never)
    .then((blob: unknown) => {
      const url = URL.createObjectURL(blob as Blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'metrics.xlsx'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    })
    .catch((e: unknown) => {
      // customError suppressed the global toast; surface the failure here.
      ElMessage.error(e instanceof Error ? e.message : String(e))
    })
}

function triggerImport() {
  importInput.value?.click()
}

function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const data = new FormData()
  data.append('file', file)
  request
    .post('/system/metric/uploadExcel', data, {
      headers: { 'Content-Type': 'multipart/form-data' },
    } as never)
    .then((res: unknown) => {
      const out = res as {
        applied: number
        by_scope?: Record<string, number>
        failed: Array<{ row: string; reason: string }>
      }
      const scopes = out.by_scope ?? {}
      const global = scopes.GLOBAL ?? 0
      const workspace = scopes.WORKSPACE ?? 0
      const personal = scopes.PERSONAL ?? 0
      if (out.failed?.length) {
        ElMessage.warning(
          t('metric.import_partial', [out.applied, global, workspace, personal, out.failed.length])
        )
      } else {
        ElMessage.success(t('metric.import_done', [out.applied, global, workspace, personal]))
      }
      search(pageInfo.currentPage)
    })
    .finally(() => {
      input.value = ''
    })
}

// ---- version history drawer ----------------------------------------------

const versionDrawer = ref(false)
const versionRows = ref<VersionRow[]>([])
const versionTitle = ref('')

function openVersions(row: MetricRow | StandardRow) {
  versionTitle.value = `${row.code} (${row.name})`
  const api = activeTab.value === 'standard' ? standardApi : metricApi
  api.versions(row.id).then((res) => {
    versionRows.value = res ?? []
    versionDrawer.value = true
  })
}

// ---- approval tab ----------------------------------------------------------

const approvalBox = ref<'pending' | 'mine'>('pending')
const approvalRows = ref<ChangeRequestRow[]>([])
const approvalLoading = ref(false)
const approvalPage = reactive({ currentPage: 1, pageSize: 20, total: 0 })

function searchRequests(page = 1) {
  approvalLoading.value = true
  metricApi
    .requests(approvalBox.value, page, approvalPage.pageSize)
    .then((res) => {
      approvalRows.value = res.data ?? []
      approvalPage.currentPage = res.current_page
      approvalPage.total = res.total_count
    })
    .finally(() => (approvalLoading.value = false))
}

function switchApprovalBox(box: 'pending' | 'mine') {
  approvalBox.value = box
  approvalPage.currentPage = 1
  searchRequests(1)
}

function review(row: ChangeRequestRow, approve: boolean) {
  const done = () => {
    ElMessage.success(approve ? t('metric.review_approved') : t('metric.review_rejected'))
    searchRequests(approvalPage.currentPage)
  }
  if (!approve) {
    ElMessageBox.prompt(t('metric.review_note_placeholder'), {
      confirmButtonType: 'primary',
      cancelButtonText: t('common.cancel'),
      inputPlaceholder: t('metric.review_note_placeholder'),
      autofocus: false,
    })
      .then(({ value }) =>
        metricApi.review({ id: row.id, approve: false, review_note: value }).then(done)
      )
      .catch(() => undefined)
    return
  }
  metricApi.review({ id: row.id, approve: true }).then(done)
}

function payloadSummary(row: ChangeRequestRow): string {
  const p = row.payload ?? {}
  const key = `${p.kind ?? ''}:${p.code ?? ''}`
  const head = `${row.action === 'remove' ? t('metric.action_remove') : t('metric.action_upsert')} ${key}`
  const body = (p.name ?? p.term) as string | undefined
  return body ? `${head} ${body}` : head
}
</script>

<template>
  <div v-loading="loading" class="metric">
    <el-tabs v-model="activeTab" @tab-change="switchTab">
      <el-tab-pane :label="t('metric.tab_atomic')" name="atomic" />
      <el-tab-pane :label="t('metric.tab_modifier')" name="modifier" />
      <el-tab-pane :label="t('metric.tab_period')" name="period" />
      <el-tab-pane :label="t('metric.tab_derived')" name="derived" />
      <el-tab-pane :label="t('metric.tab_composite')" name="composite" />
      <el-tab-pane :label="t('metric.tab_standard')" name="standard" />
      <el-tab-pane :label="t('metric.approvals')" name="approval" />
    </el-tabs>

    <!-- dictionary tabs -->
    <template v-if="activeTab !== 'approval'">
      <div class="toolbar">
        <el-radio-group
          v-if="activeTab === 'standard'"
          :model-value="stdKind"
          @change="(v: any) => ((stdKind = v), search(1))"
        >
          <el-radio-button value="naming">{{ t('metric.std_kind_naming') }}</el-radio-button>
          <el-radio-button value="unit">{{ t('metric.std_kind_unit') }}</el-radio-button>
        </el-radio-group>
        <el-select
          v-model="scopeFilter"
          clearable
          style="width: 140px"
          :placeholder="t('metric.scope')"
          @change="search(1)"
        >
          <el-option v-for="s in scopeOptions" :key="s.value" :value="s.value" :label="s.label()" />
        </el-select>
        <el-select
          v-if="isMetricTab"
          v-model="dsFilter"
          clearable
          style="width: 200px"
          :placeholder="t('metric.datasource')"
          @change="search(1)"
        >
          <el-option v-for="d in datasources" :key="d.id" :value="d.id" :label="d.name" />
        </el-select>
        <el-input
          v-model="keyword"
          style="width: 220px"
          clearable
          :placeholder="t('metric.search_placeholder')"
          :prefix-icon="icon_searchOutline_outlined"
          @keyup.enter="search(1)"
          @clear="search(1)"
        />
        <el-button type="primary" @click="openCreate">
          <el-icon><icon_add_outlined /></el-icon>
          {{ t('metric.add') }}
        </el-button>
        <el-button @click="exportExcel">{{ t('metric.export') }}</el-button>
        <el-button @click="triggerImport">{{ t('metric.import') }}</el-button>
        <input
          ref="importInput"
          type="file"
          accept=".xlsx"
          style="display: none"
          @change="onImportFile"
        />
      </div>

      <div class="table-region">
        <el-table
          :data="rows"
          height="100%"
          style="width: 100%"
          @selection-change="(sel: Array<MetricRow | StandardRow>) => (selection = sel)"
        >
          <el-table-column type="selection" width="40" />
          <el-table-column label="code" width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ row.code }}</template>
          </el-table-column>
          <el-table-column :label="t('metric.name')" width="150" show-overflow-tooltip>
            <template #default="{ row }">
              {{ activeTab === 'standard' ? (row as StandardRow).term : row.name }}
            </template>
          </el-table-column>
          <el-table-column :label="t('metric.def_summary')" min-width="240" show-overflow-tooltip>
            <template #default="{ row }">
              {{ defSummary(row) }}
              <span
                v-if="'table_exists' in row && !row.table_exists"
                class="missing-tag"
                :title="t('metric.table_missing')"
              >
                {{ t('metric.table_missing') }}
              </span>
            </template>
          </el-table-column>
          <el-table-column :label="t('metric.aliases')" width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ (row.aliases ?? []).join(', ') }}</template>
          </el-table-column>
          <el-table-column :label="t('metric.scope')" width="110">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="
                  row.scope === 'PERSONAL'
                    ? 'info'
                    : row.scope === 'WORKSPACE'
                      ? 'success'
                      : 'warning'
                "
              >
                {{ scopeLabel(row.scope) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('metric.version')" width="70">
            <template #default="{ row }">
              <el-link type="primary" @click="openVersions(row)">v{{ row.version }}</el-link>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.enableSwitch')" width="70">
            <template #default="{ row }">
              <el-switch :model-value="row.enabled" @change="(v: any) => toggleEnabled(row, !!v)" />
            </template>
          </el-table-column>
          <el-table-column :label="t('common.operate')" width="90" fixed="right">
            <template #default="{ row }">
              <el-tooltip :content="t('common.edit')" placement="top">
                <el-icon class="operate-icon" @click="openEdit(row)"><IconOpeEdit /></el-icon>
              </el-tooltip>
              <el-tooltip :content="t('common.delete')" placement="top">
                <el-icon class="operate-icon" @click="removeRows([row])"><IconOpeDelete /></el-icon>
              </el-tooltip>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyBackground
              v-if="!loading"
              :description="t('metric.empty')"
              img-type="noneWhite"
            />
          </template>
        </el-table>
      </div>
      <div class="pager">
        <el-pagination
          v-model:current-page="pageInfo.currentPage"
          :page-size="pageInfo.pageSize"
          :total="pageInfo.total"
          layout="total, prev, pager, next"
          @current-change="(p: number) => search(p)"
        />
      </div>
    </template>

    <!-- approval tab -->
    <template v-else>
      <el-radio-group :model-value="approvalBox" @change="(v: any) => switchApprovalBox(v)">
        <el-radio-button value="pending">{{ t('metric.pending_box') }}</el-radio-button>
        <el-radio-button value="mine">{{ t('metric.mine_box') }}</el-radio-button>
      </el-radio-group>
      <div class="table-region approval-region">
        <el-table
          v-loading="approvalLoading"
          :data="approvalRows"
          height="100%"
          style="width: 100%"
        >
          <el-table-column :label="t('metric.content')" min-width="260">
            <template #default="{ row }">{{ payloadSummary(row) }}</template>
          </el-table-column>
          <el-table-column :label="t('metric.target_type')" width="110">
            <template #default="{ row }">{{ scopeLabel(row.target_type) }}</template>
          </el-table-column>
          <el-table-column :label="t('metric.proposer')" width="120">
            <template #default="{ row }">{{ row.proposer ?? row.proposer_uid }}</template>
          </el-table-column>
          <el-table-column :label="t('metric.status')" width="90">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="
                  row.status === 'pending'
                    ? 'warning'
                    : row.status === 'approved'
                      ? 'success'
                      : 'info'
                "
              >
                {{ t(`metric.status_${row.status}`) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('metric.created_time')" width="160">
            <template #default="{ row }">{{
              (row.create_time ?? '').slice(0, 19).replace('T', ' ')
            }}</template>
          </el-table-column>
          <el-table-column :label="t('common.operate')" width="140" fixed="right">
            <template #default="{ row }">
              <template v-if="row.status === 'pending' && approvalBox === 'pending'">
                <el-button size="small" type="primary" @click="review(row, true)">
                  {{ t('metric.approve') }}
                </el-button>
                <el-button size="small" @click="review(row, false)">
                  {{ t('metric.reject') }}
                </el-button>
              </template>
              <span v-else-if="row.review_note">{{ row.review_note }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="pager">
        <el-pagination
          v-model:current-page="approvalPage.currentPage"
          :page-size="approvalPage.pageSize"
          :total="approvalPage.total"
          layout="total, prev, pager, next"
          @current-change="(p: number) => searchRequests(p)"
        />
      </div>
    </template>

    <!-- create / edit dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="form.id ? t('common.edit') : t('metric.add')"
      width="600px"
    >
      <el-form label-width="120px">
        <el-form-item :label="t('metric.scope')">
          <el-select v-model="form.scope" style="width: 100%">
            <el-option
              v-for="s in scopeOptions"
              :key="s.value"
              :value="s.value"
              :label="s.label()"
            />
          </el-select>
          <div class="form-tip">{{ t('metric.scope_hint') }}</div>
        </el-form-item>
        <!-- Metrics are upserted by scope + code and the payload carries no id:
             a changed code would create a second metric, so it is read-only
             while editing. -->
        <el-form-item label="code" required>
          <el-input
            v-model="form.code"
            :placeholder="t('metric.code_hint')"
            :disabled="!!form.id"
          />
        </el-form-item>
        <el-form-item v-if="activeTab !== 'standard'" :label="t('metric.name')" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item v-if="activeTab !== 'standard'" :label="t('metric.aliases')">
          <el-input v-model="form.aliasesText" :placeholder="t('metric.aliases_hint')" />
        </el-form-item>

        <!-- data-standard fields -->
        <template v-if="activeTab === 'standard'">
          <el-form-item :label="t('metric.term')" required>
            <el-input v-model="form.term" :placeholder="t('metric.term_hint')" />
          </el-form-item>
          <el-form-item :label="t('metric.standard_name')" required>
            <el-input v-model="form.standard_name" :placeholder="t('metric.standard_name_hint')" />
          </el-form-item>
          <el-form-item :label="t('metric.aliases')">
            <el-input v-model="form.aliasesText" :placeholder="t('metric.aliases_hint')" />
          </el-form-item>
          <el-form-item :label="t('metric.category')">
            <el-select v-model="form.category" style="width: 100%">
              <el-option
                v-for="c in stdKind === 'unit' ? unitCategoryOptions : namingCategoryOptions"
                :key="c.value"
                :value="c.value"
                :label="c.label()"
              />
            </el-select>
          </el-form-item>
        </template>

        <!-- atomic / modifier binding -->
        <template v-if="activeTab === 'atomic' || activeTab === 'modifier'">
          <el-form-item :label="t('metric.datasource')" required>
            <el-select v-model="form.datasource_id" style="width: 100%">
              <el-option v-for="d in datasources" :key="d.id" :value="d.id" :label="d.name" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('metric.table_name')" required>
            <el-input v-model="form.table_name" />
          </el-form-item>
          <el-form-item :label="t('metric.field_name')" required>
            <el-input v-model="form.field_name" />
          </el-form-item>
        </template>

        <!-- atomic -->
        <template v-if="activeTab === 'atomic'">
          <el-form-item :label="t('metric.aggregation')" required>
            <el-select v-model="form.aggregation" style="width: 100%">
              <el-option
                v-for="a in aggregationOptions"
                :key="a.value"
                :value="a.value"
                :label="a.label()"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('metric.unit')">
            <el-input v-model="form.unit" />
          </el-form-item>
        </template>

        <!-- modifier -->
        <template v-if="activeTab === 'modifier'">
          <el-form-item :label="t('metric.operator')" required>
            <el-select v-model="form.operator" style="width: 100%">
              <el-option
                v-for="o in operatorOptions"
                :key="o.value"
                :value="o.value"
                :label="o.label()"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('metric.values')" required>
            <el-input
              v-model="form.valuesText"
              type="textarea"
              :rows="3"
              :placeholder="t('metric.values_hint')"
            />
          </el-form-item>
        </template>

        <!-- period -->
        <template v-if="activeTab === 'period'">
          <el-form-item :label="t('metric.mode')">
            <el-radio-group v-model="form.mode">
              <el-radio-button value="recent">{{ t('metric.mode_recent') }}</el-radio-button>
              <el-radio-button value="anchor">{{ t('metric.mode_anchor') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <template v-if="form.mode === 'recent'">
            <el-form-item :label="t('metric.time_unit')" required>
              <el-select v-model="form.time_unit" style="width: 100%">
                <el-option
                  v-for="u in timeUnitOptions"
                  :key="u.value"
                  :value="u.value"
                  :label="u.label()"
                />
              </el-select>
            </el-form-item>
            <el-form-item :label="t('metric.count')" required>
              <el-input-number v-model="form.count" :min="1" step="1" controls-position="right" />
            </el-form-item>
          </template>
          <el-form-item v-else :label="t('metric.anchor')" required>
            <el-select v-model="form.anchor" style="width: 100%">
              <el-option
                v-for="a in anchorOptions"
                :key="a.value"
                :value="a.value"
                :label="a.label()"
              />
            </el-select>
          </el-form-item>
        </template>

        <!-- derived -->
        <template v-if="activeTab === 'derived'">
          <el-form-item :label="t('metric.atomic_code')" required>
            <el-input v-model="form.atomic_code" placeholder="pay_amount" />
          </el-form-item>
          <el-form-item :label="t('metric.modifier_codes')">
            <el-input
              v-model="form.modifier_codesText"
              :placeholder="t('metric.modifier_codes_hint')"
            />
          </el-form-item>
          <el-form-item :label="t('metric.period_code')">
            <el-input v-model="form.period_code" placeholder="last_7d" />
          </el-form-item>
          <el-form-item :label="t('metric.time_field')">
            <el-input v-model="form.time_field" :placeholder="t('metric.time_field_hint')" />
          </el-form-item>
        </template>

        <!-- composite -->
        <template v-if="activeTab === 'composite'">
          <el-form-item :label="t('metric.expression')" required>
            <el-input v-model="form.expression" placeholder="pay_7d / pay_users_7d" />
            <div class="form-tip">{{ t('metric.expression_hint') }}</div>
          </el-form-item>
        </template>

        <el-form-item :label="t('metric.description')">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item :label="t('metric.note')">
          <el-input v-model="form.note" :placeholder="t('metric.note_placeholder')" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="submitForm">
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- version history drawer -->
    <el-drawer v-model="versionDrawer" :title="versionTitle" size="480px">
      <el-timeline>
        <el-timeline-item
          v-for="v in versionRows"
          :key="v.id"
          :timestamp="(v.create_time ?? '').slice(0, 19).replace('T', ' ')"
        >
          <div class="version-item">
            <b>v{{ v.version }}</b>
            <span class="version-meaning">
              {{ (v.snapshot?.name as string) ?? (v.snapshot?.term as string) ?? '' }}
              <span v-if="v.snapshot?.source" class="version-source"
                >({{ v.snapshot.source }})</span
              >
            </span>
            <span v-if="v.note" class="version-note">{{ v.note }}</span>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-drawer>
  </div>
</template>

<style scoped lang="less">
.metric {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;

  :deep(.ed-tabs) {
    flex: none;
  }

  .toolbar {
    display: flex;
    flex: none;
    gap: 8px;
    margin-bottom: 12px;
  }

  // The table takes the remaining height so the pager can sit at the bottom
  // of the page instead of floating right under the table.
  .table-region {
    flex: 1;
    min-height: 0;
  }

  .approval-region {
    margin-top: 12px;
  }

  .pager {
    display: flex;
    flex: none;
    justify-content: flex-end;
    margin-top: 12px;
  }

  .missing-tag {
    margin-left: 6px;
    color: #f56c6c;
    font-size: 12px;
  }

  .operate-icon {
    cursor: pointer;
    margin-right: 10px;
    color: rgba(100, 106, 115, 1);

    &:hover {
      color: var(--ed-color-primary);
    }
  }

  .form-tip {
    width: 100%;
    font-size: 12px;
    line-height: 18px;
    color: rgba(143, 149, 158, 1);
  }

  .version-item {
    display: flex;
    flex-direction: column;

    .version-meaning {
      margin-top: 2px;
    }

    .version-source {
      color: rgba(143, 149, 158, 1);
      font-size: 12px;
    }

    .version-note {
      margin-top: 2px;
      color: rgba(143, 149, 158, 1);
      font-size: 12px;
    }
  }
}
</style>
