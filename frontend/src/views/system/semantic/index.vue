<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus-secondary'
import {
  semanticApi,
  type EnumCollectSummary,
  type SemanticChangeRequestRow,
  type SemanticEntityType,
  type SemanticRow,
  type SemanticScope,
  type SemanticVersionRow,
} from '@/api/semantic'
import { datasourceApi } from '@/api/datasource'
import { request } from '@/utils/request'
import { splitAliases } from '@/utils/utils'

/** ISO string → "YYYY-MM-DD HH:mm:ss" (create_time is an ISO string on the
 *  semantic wire; utils/date.formatTimestamp expects an epoch number). */
function fmt(iso?: string | null): string {
  return (iso ?? '').slice(0, 19).replace('T', ' ')
}
import EmptyBackground from '@/views/dashboard/common/EmptyBackground.vue'
import icon_add_outlined from '@/assets/svg/icon_add_outlined.svg'
import IconOpeEdit from '@/assets/svg/icon_edit_outlined.svg'
import IconOpeDelete from '@/assets/svg/icon_delete.svg'
import icon_searchOutline_outlined from '@/assets/svg/icon_search-outline_outlined.svg'

/** MetaDataImprove M2 — semantic admin page: table/field meanings with a
 *  3-layer scope (personal > workspace > global), an approval inbox for
 *  cross-layer proposals, and per-entity version history. */
const { t } = useI18n()

const activeTab = ref<'table' | 'field' | 'approval'>('table')
const loading = ref(false)
const rows = ref<SemanticRow[]>([])
const datasources = ref<Array<{ id: number; name: string }>>([])
const scopeFilter = ref<'' | SemanticScope>('')
const keyword = ref('')
const dsFilter = ref<number | undefined>(undefined)
const pageInfo = reactive({ currentPage: 1, pageSize: 10, total: 0 })

const entityType = computed<SemanticEntityType>(() =>
  activeTab.value === 'field' ? 'field' : 'table'
)

const scopeOptions = [
  { value: 'GLOBAL', label: () => t('semantic.scope_global') },
  { value: 'WORKSPACE', label: () => t('semantic.scope_workspace') },
  { value: 'PERSONAL', label: () => t('semantic.scope_personal') },
]

const roleOptions = [
  { value: 'metric', label: () => t('semantic.role_metric') },
  { value: 'dimension', label: () => t('semantic.role_dimension') },
  { value: 'time', label: () => t('semantic.role_time') },
  { value: 'other', label: () => t('semantic.role_other') },
]

const scopeLabel = (scope: string) => scopeOptions.find((s) => s.value === scope)?.label() ?? scope

const roleLabel = (role?: string) =>
  roleOptions.find((r) => r.value === role)?.label() ?? role ?? ''

const dsName = (id: number) => datasources.value.find((d) => d.id === id)?.name ?? `#${id}`

function search(page = 1) {
  loading.value = true
  semanticApi
    .page(entityType.value, page, pageInfo.pageSize, {
      scope: scopeFilter.value || undefined,
      datasource_id: dsFilter.value,
      keyword: keyword.value || undefined,
    })
    .then((res) => {
      rows.value = res.data ?? []
      pageInfo.currentPage = res.current_page
      pageInfo.total = res.total_count
    })
    .finally(() => {
      loading.value = false
    })
}

onMounted(() => {
  datasourceApi.list().then((res: any) => {
    datasources.value = [...res]
  })
  search()
})

// ---- create / edit dialog ----------------------------------------------

const dialogVisible = ref(false)
const saving = ref(false)
const defaultForm = () => ({
  id: null as number | null,
  scope: 'WORKSPACE' as SemanticScope,
  datasource_id: undefined as number | undefined,
  table_name: '',
  field_name: '',
  role: 'dimension',
  meaning: '',
  aliasesText: '',
  unit: '',
  enumText: '',
  note: '',
})
const form = reactive(defaultForm())

function openCreate() {
  Object.assign(form, defaultForm())
  if (dsFilter.value) form.datasource_id = dsFilter.value
  dialogVisible.value = true
}

function openEdit(row: SemanticRow) {
  Object.assign(form, defaultForm(), {
    id: row.id,
    scope: row.scope,
    datasource_id: row.datasource_id,
    table_name: row.table_name,
    field_name: row.field_name ?? '',
    role: row.role ?? 'dimension',
    meaning: row.meaning,
    aliasesText: (row.aliases ?? []).join(', '),
    unit: row.unit ?? '',
    enumText: (row.enum_values ?? [])
      .map((e) => (e.label ? `${e.value}|${e.label}` : e.value))
      .join('\n'),
    note: '',
  })
  dialogVisible.value = true
}

function submitForm() {
  if (!form.datasource_id || !form.table_name.trim() || !form.meaning.trim()) {
    ElMessage.error(t('semantic.form_required'))
    return
  }
  if (entityType.value === 'field' && !form.field_name.trim()) {
    ElMessage.error(t('semantic.form_required'))
    return
  }
  const payload: Record<string, unknown> = {
    entity_type: entityType.value,
    scope: form.scope,
    datasource_id: form.datasource_id,
    table_name: form.table_name.trim(),
    meaning: form.meaning.trim(),
    // Always send aliases (including []) so clearing the field clears the
    // stored list instead of leaving stale recall synonyms behind.
    aliases: splitAliases(form.aliasesText),
    note: form.note.trim() || undefined,
  }
  if (entityType.value === 'field') {
    payload.field_name = form.field_name.trim()
    payload.role = form.role
    if (form.unit.trim()) payload.unit = form.unit.trim()
    const enum_values = form.enumText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [value, label] = line.split('|')
        return label ? { value: value.trim(), label: label.trim() } : { value }
      })
    // Always send the array (including []) so clearing the textarea clears the
    // stored enum cache instead of leaving the old values in place.
    payload.enum_values = enum_values
  }
  saving.value = true
  semanticApi
    .upsert(payload)
    .then((res) => {
      if (!res.applied) {
        // Lower-layer proposal → waiting for the layer admin's approval.
        ElMessage.success(t('semantic.proposed_hint'))
      } else {
        ElMessage.success(t('common.save_success'))
      }
      dialogVisible.value = false
      search(pageInfo.currentPage)
    })
    .finally(() => {
      saving.value = false
    })
}

/** Tracked table selection (updated via @selection-change). */
const selection = ref<SemanticRow[]>([])

function removeRows(target?: SemanticRow[]) {
  const victims = target ?? selection.value
  if (victims.length === 0) return
  ElMessageBox.confirm(t('semantic.delete_hint', [victims.length]), {
    confirmButtonType: 'primary',
    confirmButtonText: t('common.confirm2'),
    cancelButtonText: t('common.cancel'),
    customClass: 'confirm-no_icon',
    autofocus: false,
  }).then(() => {
    semanticApi
      .remove(
        entityType.value,
        victims.map((r) => r.id)
      )
      .then((res: { removed: number; requested: number }) => {
        if (res.requested > 0) ElMessage.success(t('semantic.proposed_hint'))
        search(pageInfo.currentPage)
      })
  })
}

const importInput = ref()

function exportExcel() {
  request
    .get('/system/semantic/export', {
      responseType: 'blob',
      requestOptions: { customError: true },
    } as never)
    .then((blob: unknown) => {
      const url = URL.createObjectURL(blob as Blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'semantics.xlsx'
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
  const form = new FormData()
  form.append('file', file)
  request
    .post('/system/semantic/uploadExcel', form, {
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
          t('semantic.import_partial', [
            out.applied,
            global,
            workspace,
            personal,
            out.failed.length,
          ])
        )
      } else {
        ElMessage.success(t('semantic.import_done', [out.applied, global, workspace, personal]))
      }
      search(pageInfo.currentPage)
    })
    .finally(() => {
      input.value = ''
    })
}

function toggleEnabled(row: SemanticRow, enabled: boolean) {
  semanticApi.setEnabled(entityType.value, row.id, enabled).then(() => {
    row.enabled = enabled
  })
}

// ---- dimension-enum collection (MetaDataImprove M3.3) --------------------

const collecting = ref(false)

/** One-click enum sampling for the SELECTED datasource's dimension fields.
 *  Server-side rate-limited; the response reports per-field outcomes. */
function collectEnums() {
  if (!dsFilter.value) {
    ElMessage.warning(t('semantic.collect_enum_pick_ds'))
    return
  }
  collecting.value = true
  semanticApi
    .collectEnum(dsFilter.value)
    .then((res: EnumCollectSummary) => {
      const collected = res.collected.length
      const skipped = res.skipped.length
      if (collected === 0 && skipped === 0) {
        ElMessage.info(t('semantic.collect_enum_none'))
      } else if (skipped > 0) {
        ElMessage.warning(t('semantic.collect_enum_partial', [collected, skipped]))
      } else {
        ElMessage.success(t('semantic.collect_enum_done', [collected]))
      }
      search(pageInfo.currentPage)
    })
    .finally(() => {
      collecting.value = false
    })
}

// ---- version history drawer --------------------------------------------

const versionDrawer = ref(false)
const versionRows = ref<SemanticVersionRow[]>([])
const versionTitle = ref('')

function openVersions(row: SemanticRow) {
  versionTitle.value = row.table_name + (row.field_name ? `.${row.field_name}` : '')
  semanticApi.versions(entityType.value, row.id).then((res) => {
    versionRows.value = res ?? []
    versionDrawer.value = true
  })
}

// ---- approval tab --------------------------------------------------------

const approvalBox = ref<'pending' | 'mine'>('pending')
const approvalRows = ref<SemanticChangeRequestRow[]>([])
const approvalLoading = ref(false)
const approvalPage = reactive({ currentPage: 1, pageSize: 20, total: 0 })

function searchRequests(page = 1) {
  approvalLoading.value = true
  semanticApi
    .requests(approvalBox.value, page, approvalPage.pageSize)
    .then((res) => {
      approvalRows.value = res.data ?? []
      approvalPage.currentPage = res.current_page
      approvalPage.total = res.total_count
    })
    .finally(() => {
      approvalLoading.value = false
    })
}

function switchApprovalBox(box: 'pending' | 'mine') {
  approvalBox.value = box
  approvalPage.currentPage = 1
  searchRequests(1)
}

function switchTab(tab: string | number) {
  if (tab === 'approval') searchRequests()
  else search(1)
}

function review(row: SemanticChangeRequestRow, approve: boolean) {
  const done = () => {
    ElMessage.success(approve ? t('semantic.review_approved') : t('semantic.review_rejected'))
    searchRequests(approvalPage.currentPage)
  }
  if (!approve) {
    ElMessageBox.prompt(t('semantic.review_note_placeholder'), {
      confirmButtonType: 'primary',
      cancelButtonText: t('common.cancel'),
      inputPlaceholder: t('semantic.review_note_placeholder'),
      autofocus: false,
    })
      .then(({ value }) =>
        semanticApi.review({ id: row.id, approve: false, review_note: value }).then(done)
      )
      .catch(() => undefined)
    return
  }
  semanticApi.review({ id: row.id, approve: true }).then(done)
}

function payloadSummary(row: SemanticChangeRequestRow): string {
  const p = row.payload ?? {}
  const key = [p.table_name, p.field_name].filter(Boolean).join('.')
  const head = `${row.action === 'remove' ? t('semantic.action_remove') : t('semantic.action_upsert')} ${key}`
  const aliases = Array.isArray(p.aliases) ? (p.aliases as string[]).join(', ') : ''
  const aliasText = aliases ? ` [${t('semantic.aliases')}: ${aliases}]` : ''
  return p.meaning ? `${head}：${p.meaning}${aliasText}` : `${head}${aliasText}`
}
</script>

<template>
  <div v-loading="loading" class="semantic">
    <el-tabs v-model="activeTab" @tab-change="switchTab">
      <el-tab-pane :label="t('semantic.table_semantics')" name="table" />
      <el-tab-pane :label="t('semantic.field_semantics')" name="field" />
      <el-tab-pane :label="t('semantic.approvals')" name="approval" />
    </el-tabs>

    <!-- entity tabs -->
    <template v-if="activeTab !== 'approval'">
      <div class="toolbar">
        <el-select
          v-model="scopeFilter"
          clearable
          style="width: 140px"
          :placeholder="t('semantic.scope')"
          @change="search(1)"
        >
          <el-option v-for="s in scopeOptions" :key="s.value" :value="s.value" :label="s.label()" />
        </el-select>
        <el-select
          v-model="dsFilter"
          clearable
          style="width: 200px"
          :placeholder="t('semantic.datasource')"
          @change="search(1)"
        >
          <el-option v-for="d in datasources" :key="d.id" :value="d.id" :label="d.name" />
        </el-select>
        <el-input
          v-model="keyword"
          style="width: 240px"
          clearable
          :placeholder="t('semantic.search_placeholder')"
          :prefix-icon="icon_searchOutline_outlined"
          @keyup.enter="search(1)"
          @clear="search(1)"
        />
        <el-button type="primary" @click="openCreate">
          <el-icon><icon_add_outlined /></el-icon>
          {{ t('semantic.add') }}
        </el-button>
        <el-button
          v-if="activeTab === 'field'"
          :loading="collecting"
          :title="t('semantic.collect_enum_hint')"
          @click="collectEnums"
        >
          {{ t('semantic.collect_enum') }}
        </el-button>
        <el-button @click="exportExcel">{{ t('semantic.export') }}</el-button>
        <el-button @click="triggerImport">{{ t('semantic.import') }}</el-button>
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
          @selection-change="(sel: SemanticRow[]) => (selection = sel)"
        >
          <el-table-column type="selection" width="40" />
          <el-table-column :label="t('semantic.datasource')" width="140">
            <template #default="{ row }">{{ dsName(row.datasource_id) }}</template>
          </el-table-column>
          <el-table-column :label="t('semantic.table_name')" width="160">
            <template #default="{ row }">
              <span>{{ row.table_name }}</span>
              <span v-if="row.field_name" class="field-name">.{{ row.field_name }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="activeTab === 'field'" :label="t('semantic.role')" width="90">
            <template #default="{ row }">{{ roleLabel(row.role) }}</template>
          </el-table-column>
          <el-table-column :label="t('semantic.meaning')" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.meaning }}
              <span v-if="row.unit" class="unit-tag">{{ row.unit }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('semantic.aliases')" width="160" show-overflow-tooltip>
            <template #default="{ row }">{{ (row.aliases ?? []).join(', ') }}</template>
          </el-table-column>
          <el-table-column :label="t('semantic.scope')" width="110">
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
          <el-table-column :label="t('semantic.version')" width="70">
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
              :description="t('semantic.empty')"
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
        <el-radio-button value="pending">{{ t('semantic.pending_box') }}</el-radio-button>
        <el-radio-button value="mine">{{ t('semantic.mine_box') }}</el-radio-button>
      </el-radio-group>
      <div class="table-region approval-region">
        <el-table
          v-loading="approvalLoading"
          :data="approvalRows"
          height="100%"
          style="width: 100%"
        >
          <el-table-column :label="t('semantic.content')" min-width="260">
            <template #default="{ row }">{{ payloadSummary(row) }}</template>
          </el-table-column>
          <el-table-column :label="t('semantic.target_type')" width="110">
            <template #default="{ row }">{{ scopeLabel(row.target_type) }}</template>
          </el-table-column>
          <el-table-column :label="t('semantic.proposer')" width="120">
            <template #default="{ row }">{{ row.proposer ?? row.proposer_uid }}</template>
          </el-table-column>
          <el-table-column :label="t('semantic.status')" width="90">
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
                {{ t(`semantic.status_${row.status}`) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('semantic.created_time')" width="160">
            <template #default="{ row }">{{ fmt(row.create_time) }}</template>
          </el-table-column>
          <el-table-column :label="t('common.operate')" width="140" fixed="right">
            <template #default="{ row }">
              <template v-if="row.status === 'pending' && approvalBox === 'pending'">
                <el-button size="small" type="primary" @click="review(row, true)">
                  {{ t('semantic.approve') }}
                </el-button>
                <el-button size="small" @click="review(row, false)">
                  {{ t('semantic.reject') }}
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
      :title="form.id ? t('common.edit') : t('semantic.add')"
      width="560px"
    >
      <el-form label-width="110px">
        <el-form-item :label="t('semantic.scope')">
          <el-select v-model="form.scope" style="width: 100%">
            <el-option
              v-for="s in scopeOptions"
              :key="s.value"
              :value="s.value"
              :label="s.label()"
            />
          </el-select>
          <div class="form-tip">{{ t('semantic.scope_hint') }}</div>
        </el-form-item>
        <el-form-item :label="t('semantic.datasource')" required>
          <el-select v-model="form.datasource_id" style="width: 100%">
            <el-option v-for="d in datasources" :key="d.id" :value="d.id" :label="d.name" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('semantic.table_name')" required>
          <el-input v-model="form.table_name" />
        </el-form-item>
        <template v-if="activeTab === 'field'">
          <el-form-item :label="t('semantic.field_name')" required>
            <el-input v-model="form.field_name" />
          </el-form-item>
          <el-form-item :label="t('semantic.role')">
            <el-select v-model="form.role" style="width: 100%">
              <el-option
                v-for="r in roleOptions"
                :key="r.value"
                :value="r.value"
                :label="r.label()"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('semantic.unit')">
            <el-input v-model="form.unit" />
          </el-form-item>
          <el-form-item :label="t('semantic.enum_values')">
            <el-input
              v-model="form.enumText"
              type="textarea"
              :rows="3"
              :placeholder="t('semantic.enum_values_hint')"
            />
          </el-form-item>
        </template>
        <el-form-item :label="t('semantic.meaning')" required>
          <el-input v-model="form.meaning" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item :label="t('semantic.aliases')">
          <el-input v-model="form.aliasesText" :placeholder="t('semantic.aliases_hint')" />
        </el-form-item>
        <el-form-item :label="t('semantic.note')">
          <el-input v-model="form.note" :placeholder="t('semantic.note_placeholder')" />
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
        <el-timeline-item v-for="v in versionRows" :key="v.id" :timestamp="fmt(v.create_time)">
          <div class="version-item">
            <b>v{{ v.version }}</b>
            <span class="version-meaning">{{ v.snapshot?.meaning }}</span>
            <span v-if="v.snapshot?.aliases?.length" class="version-note">
              {{ t('semantic.aliases') }}: {{ v.snapshot.aliases.join(', ') }}
            </span>
            <span v-if="v.note" class="version-note">{{ v.note }}</span>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-drawer>
  </div>
</template>

<style scoped lang="less">
.semantic {
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

  .field-name {
    color: rgba(143, 149, 158, 1);
  }

  .unit-tag {
    margin-left: 6px;
    color: rgba(143, 149, 158, 1);
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

    .version-note {
      margin-top: 2px;
      color: rgba(143, 149, 158, 1);
      font-size: 12px;
    }
  }
}
</style>
