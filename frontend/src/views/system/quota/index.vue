<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus-secondary'
import { quotaApi, type BudgetSubjectType, type QueryBudgetRow } from '@/api/quota'
import { mcpApi } from '@/api/mcp'
import { request } from '@/utils/request'

const { t } = useI18n()

const loading = ref(false)
const list = ref<QueryBudgetRow[]>([])

const search = () => {
  loading.value = true
  quotaApi
    .overview()
    .then((res) => {
      list.value = res || []
    })
    .finally(() => {
      loading.value = false
    })
}
onMounted(search)

const typeLabel = (type: BudgetSubjectType) => t(`quota.subject_${type}`)
const subjectLabel = (row: QueryBudgetRow) =>
  row.subject_type === 'default'
    ? t('quota.workspace_default')
    : `${typeLabel(row.subject_type)} #${row.subject_id}`
const remaining = (row: QueryBudgetRow) =>
  row.used_today == null ? '-' : Math.max(0, row.daily_limit - row.used_today)

// --- subject option sources ---------------------------------------------
interface SubjectOption {
  value: number
  label: string
}
const userOptions = ref<SubjectOption[]>([])
const mcpOptions = ref<SubjectOption[]>([])
const assistantOptions = ref<SubjectOption[]>([])

const loadSubjects = () => {
  // Workspace admins (WsAdminGuard) cannot read /user/pager (system admin
  // only), but they can list their own workspace members here.
  request
    .get<any>('/system/workspace/uws/pager/1/200')
    .then((res: any) => {
      const rows = res?.items ?? []
      userOptions.value = rows.map((u: any) => ({
        value: u.id,
        label: `${u.account}(${u.name ?? u.id})`,
      }))
    })
    .catch(() => undefined)
  mcpApi
    .list()
    .then((rows) => {
      mcpOptions.value = (rows || []).map((m: any) => ({
        value: m.id,
        label: m.name,
      }))
    })
    .catch(() => undefined)
  request
    .get<any>('/system/embedded/1/200', {})
    .then((res: any) => {
      const rows = res?.items ?? []
      assistantOptions.value = rows.map((a: any) => ({
        value: a.id,
        label: a.name,
      }))
    })
    .catch(() => undefined)
}
onMounted(loadSubjects)

const optionsForType = computed(() => {
  switch (form.subject_type) {
    case 'user':
      return userOptions.value
    case 'mcp_integration':
      return mcpOptions.value
    case 'assistant':
      return assistantOptions.value
    default:
      return []
  }
})

// --- create / edit -------------------------------------------------------
const dialog = ref(false)
const saving = ref(false)
const formRef = ref()
const form = reactive({
  id: null as number | null,
  subject_type: 'default' as BudgetSubjectType,
  subject_id: null as number | null,
  daily_limit: 100,
})
const rules = computed(() => ({
  daily_limit: [{ required: true, message: t('quota.limit_required'), trigger: 'blur' }],
  subject_id:
    form.subject_type === 'default'
      ? []
      : [{ required: true, message: t('quota.subject_required'), trigger: 'change' }],
}))

const openCreate = () => {
  form.id = null
  form.subject_type = 'default'
  form.subject_id = null
  form.daily_limit = 100
  dialog.value = true
}
const openEdit = (row: QueryBudgetRow) => {
  form.id = row.id
  form.subject_type = row.subject_type
  form.subject_id = row.subject_id
  form.daily_limit = row.daily_limit
  dialog.value = true
}
const onTypeChange = () => {
  form.subject_id = null
}

const save = () => {
  formRef.value?.validate((valid: boolean) => {
    if (!valid) return
    saving.value = true
    quotaApi
      .upsert({
        subject_type: form.subject_type,
        subject_id: form.subject_type === 'default' ? null : form.subject_id,
        daily_limit: form.daily_limit,
      })
      .then(() => {
        ElMessage.success(t('quota.saved'))
        dialog.value = false
        search()
      })
      .finally(() => {
        saving.value = false
      })
  })
}

const remove = (row: QueryBudgetRow) => {
  ElMessageBox.confirm(
    t('quota.remove_confirm', { subject: subjectLabel(row) }),
    t('quota.confirm_title'),
    { type: 'warning' }
  )
    .then(() => quotaApi.remove(row.id))
    .then(() => {
      ElMessage.success(t('quota.removed'))
      search()
    })
    .catch(() => undefined)
}
</script>

<template>
  <div class="page-container">
    <div class="toolbar">
      <h2 class="page-title">{{ t('quota.menu_title') }}</h2>
      <div>
        <el-button type="primary" @click="openCreate">{{ t('quota.create') }}</el-button>
        <el-button :loading="loading" @click="search">{{ t('quota.refresh') }}</el-button>
      </div>
    </div>
    <p class="page-hint">{{ t('quota.hint') }}</p>

    <el-table v-loading="loading" :data="list" border>
      <el-table-column :label="t('quota.subject')">
        <template #default="{ row }">
          <span>{{ subjectLabel(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="daily_limit" :label="t('quota.daily_limit')" width="140" />
      <el-table-column :label="t('quota.used_today')" width="140">
        <template #default="{ row }">
          <span>{{ row.used_today == null ? '-' : row.used_today }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('quota.remaining')" width="120">
        <template #default="{ row }">
          <span>{{ remaining(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('quota.operations')">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">{{ t('quota.edit') }}</el-button>
          <el-button link type="danger" @click="remove(row)">{{ t('quota.delete') }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="t('quota.create')" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item :label="t('quota.subject_type')">
          <el-select v-model="form.subject_type" style="width: 100%" @change="onTypeChange">
            <el-option value="default" :label="t('quota.workspace_default')" />
            <el-option value="user" :label="t('quota.subject_user')" />
            <el-option value="mcp_integration" :label="t('quota.subject_mcp_integration')" />
            <el-option value="assistant" :label="t('quota.subject_assistant')" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="form.subject_type !== 'default'"
          :label="t('quota.subject')"
          prop="subject_id"
        >
          <el-select
            v-model="form.subject_id"
            filterable
            :placeholder="t('quota.subject_required')"
            style="width: 100%"
          >
            <el-option
              v-for="opt in optionsForType"
              :key="opt.value"
              :value="opt.value"
              :label="opt.label"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('quota.daily_limit')" prop="daily_limit">
          <el-input-number v-model="form.daily_limit" :min="1" :max="1000000" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ t('quota.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{
          t('quota.confirm')
        }}</el-button>
      </template>
    </el-dialog>
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
}
.page-title {
  margin: 0;
  font-size: 16px;
}
.page-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin: 8px 0 12px;
}
</style>
