<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClipboard } from '@vueuse/core'
import icon_add_outlined from '@/assets/svg/icon_add_outlined.svg'
import icon_searchOutline_outlined from '@/assets/svg/icon_search-outline_outlined.svg'
import icon_copy_outlined from '@/assets/svg/icon_copy_outlined.svg'
import icon_visible_outlined from '@/assets/embedded/icon_visible_outlined.svg'
import icon_invisible_outlined from '@/assets/embedded/icon_invisible_outlined.svg'
import icon_refresh_outlined from '@/assets/embedded/icon_refresh_outlined.svg'
import IconOpeEdit from '@/assets/svg/icon_edit_outlined.svg'
import IconOpeDelete from '@/assets/svg/icon_delete.svg'
import EmptyBackground from '@/views/dashboard/common/EmptyBackground.vue'
import { mcpApi, type McpIntegration } from '@/api/mcp'

type IntegrationRow = McpIntegration & { showToken: boolean }

const { t } = useI18n()
const { copy } = useClipboard({ legacy: true })

const loading = ref(false)
const keyword = ref('')
const list = ref<IntegrationRow[]>([])
const pwd = '**********'

const endpoint = computed(() => {
  const base = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/+$/, '')
  if (/^https?:\/\//i.test(base)) return `${base}/mcp`
  // Resolve against the document URL so sub-path deployments keep their
  // prefix: with base './api/v1' the page https://host/app/ must yield
  // https://host/app/api/v1/mcp, not https://host/api/v1/mcp (which is what
  // origin-joining produced).
  return new URL(`${base}/mcp`, window.location.href).href
})

const tools = [
  'list_datasources',
  'list_tables',
  'describe_table',
  'list_models',
  'start_chat',
  'ask_question',
]

const search = () => {
  loading.value = true
  mcpApi
    .list({ keyword: keyword.value.trim() || undefined })
    .then((res) => {
      list.value = (res || []).map((row) => ({ ...row, showToken: false }))
    })
    .finally(() => {
      loading.value = false
    })
}

onMounted(search)

const copyValue = (value: string) =>
  copy(value)
    .then(() => ElMessage.success(t('mcp.copy_successful')))
    .catch(() => ElMessage.error(t('mcp.copy_failed')))

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : '-')

// --- create / edit -------------------------------------------------------

const dialogVisible = ref(false)
const dialogTitle = ref('')
const formRef = ref()
const form = reactive<{ id: number | null; name: string; description: string }>({
  id: null,
  name: '',
  description: '',
})
const rules = {
  name: [
    {
      required: true,
      message: t('mcp.name_required'),
      trigger: 'blur',
    },
  ],
}

const openCreate = () => {
  form.id = null
  form.name = ''
  form.description = ''
  dialogTitle.value = t('mcp.create')
  dialogVisible.value = true
}

const openEdit = (row: IntegrationRow) => {
  form.id = row.id
  form.name = row.name
  form.description = row.description ?? ''
  dialogTitle.value = t('mcp.edit')
  dialogVisible.value = true
}

const closeForm = () => {
  dialogVisible.value = false
}

const save = () => {
  formRef.value
    ?.validate()
    .then(async (valid: boolean) => {
      if (!valid) return
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
      }
      if (form.id) {
        await mcpApi.update({ id: form.id, ...payload })
        ElMessage.success(t('common.save_success'))
        closeForm()
        search()
        return
      }
      const created = await mcpApi.create(payload)
      closeForm()
      search()
      if (created?.token) {
        issuedToken.value = created.token
        issuedName.value = created.name
        tokenDialogVisible.value = true
      }
    })
    .catch(() => undefined)
}

// --- token reveal / rotate ----------------------------------------------

const tokenDialogVisible = ref(false)
const issuedToken = ref('')
const issuedName = ref('')

const ensureToken = (row: IntegrationRow): Promise<void> => {
  if (row.token) return Promise.resolve()
  return mcpApi.reveal(row.id).then((res) => {
    row.token = res?.token ?? ''
  })
}

const toggleToken = (row: IntegrationRow) => {
  if (row.showToken) {
    row.showToken = false
    return
  }
  ensureToken(row)
    .then(() => {
      row.showToken = true
    })
    .catch(() => undefined)
}

const copyToken = (row: IntegrationRow) => {
  ensureToken(row)
    .then(() => copyValue(row.token))
    .catch(() => undefined)
}

const rotateToken = (row: IntegrationRow) => {
  ElMessageBox.confirm(t('mcp.rotate_confirm', { name: row.name }), {
    confirmButtonType: 'danger',
    confirmButtonText: t('mcp.rotate'),
    cancelButtonText: t('common.cancel'),
    customClass: 'confirm-no_icon',
    autofocus: false,
  })
    .then(() => {
      mcpApi.rotate(row.id).then((res) => {
        row.token = res?.token ?? ''
        row.showToken = true
        issuedToken.value = row.token
        issuedName.value = row.name
        tokenDialogVisible.value = true
        ElMessage.success(t('mcp.token_rotated'))
      })
    })
    .catch(() => undefined)
}

const toggleStatus = (row: IntegrationRow) => {
  const previous = row.status
  const next = previous === 'active' ? 'disabled' : 'active'
  row.status = next
  mcpApi
    .update({ id: row.id, status: next })
    .then(() => {
      ElMessage.success(t('mcp.status_updated'))
    })
    .catch(() => {
      row.status = previous
    })
}

const deleteHandler = (row: IntegrationRow) => {
  ElMessageBox.confirm(t('mcp.delete_confirm', { name: row.name }), {
    confirmButtonType: 'danger',
    confirmButtonText: t('dashboard.delete'),
    cancelButtonText: t('common.cancel'),
    customClass: 'confirm-no_icon',
    autofocus: false,
  })
    .then(() => {
      mcpApi.remove(row.id).then(() => {
        ElMessage.success(t('dashboard.delete_success'))
        search()
      })
    })
    .catch(() => undefined)
}

// --- connection guide ----------------------------------------------------

const guideVisible = ref(false)
const guideRow = ref<IntegrationRow | null>(null)

const openGuide = (row: IntegrationRow) => {
  ensureToken(row)
    .then(() => {
      guideRow.value = row
      guideVisible.value = true
    })
    .catch(() => undefined)
}

const guideJson = computed(() => {
  const token = guideRow.value?.token ?? '<token>'
  return JSON.stringify(
    {
      mcpServers: {
        queryprism: {
          type: 'streamable-http',
          url: endpoint.value,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2
  )
})

const copyGuide = () => copyValue(guideJson.value)
</script>

<template>
  <div v-loading="loading" class="mcp-page">
    <div class="tool-left">
      <div class="title-block">
        <span class="page-title">{{ t('mcp.title') }}</span>
        <span class="page-subtitle">{{ t('mcp.subtitle') }}</span>
      </div>
      <div class="tool-actions">
        <el-input
          v-model="keyword"
          style="width: 240px"
          :placeholder="$t('dashboard.search')"
          clearable
          @keydown.enter.exact.prevent="search"
          @clear="search"
        >
          <template #prefix>
            <el-icon>
              <icon_searchOutline_outlined />
            </el-icon>
          </template>
        </el-input>
        <el-button type="primary" @click="openCreate">
          <template #icon>
            <icon_add_outlined></icon_add_outlined>
          </template>
          {{ t('mcp.create') }}
        </el-button>
      </div>
    </div>

    <template v-if="!loading && !list.length">
      <EmptyBackground :description="$t('mcp.empty')" img-type="noneWhite" />
    </template>

    <div v-else class="table-content">
      <el-table :data="list" style="width: 100%">
        <el-table-column prop="name" :label="t('mcp.name')" min-width="160">
          <template #default="scope">
            <div class="name-cell">
              <div class="name" :title="scope.row.name">{{ scope.row.name }}</div>
              <div v-if="scope.row.description" class="desc" :title="scope.row.description">
                {{ scope.row.description }}
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('mcp.endpoint')" min-width="280">
          <template #default>
            <div class="value-cell">
              <span class="ellipsis" :title="endpoint">{{ endpoint }}</span>
              <el-tooltip
                :offset="12"
                effect="dark"
                :content="t('datasource.copy')"
                placement="top"
              >
                <el-icon size="16" class="hover-icon_with_bg" @click="copyValue(endpoint)">
                  <icon_copy_outlined></icon_copy_outlined>
                </el-icon>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('mcp.token')" min-width="260">
          <template #default="scope">
            <div class="value-cell">
              <span
                class="ellipsis"
                style="max-width: 180px"
                :title="scope.row.showToken ? scope.row.token : pwd"
              >
                {{ scope.row.showToken ? scope.row.token : pwd }}
              </span>
              <el-tooltip
                :offset="12"
                effect="dark"
                :content="scope.row.showToken ? t('mcp.hide') : t('mcp.show')"
                placement="top"
              >
                <el-icon size="16" class="hover-icon_with_bg" @click="toggleToken(scope.row)">
                  <icon_visible_outlined v-if="!scope.row.showToken"></icon_visible_outlined>
                  <icon_invisible_outlined v-else></icon_invisible_outlined>
                </el-icon>
              </el-tooltip>
              <el-tooltip
                :offset="12"
                effect="dark"
                :content="t('datasource.copy')"
                placement="top"
              >
                <el-icon size="16" class="hover-icon_with_bg" @click="copyToken(scope.row)">
                  <icon_copy_outlined></icon_copy_outlined>
                </el-icon>
              </el-tooltip>
              <el-tooltip :offset="12" effect="dark" :content="t('mcp.rotate')" placement="top">
                <el-icon size="16" class="hover-icon_with_bg" @click="rotateToken(scope.row)">
                  <icon_refresh_outlined></icon_refresh_outlined>
                </el-icon>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>

        <el-table-column :label="t('mcp.status')" width="100">
          <template #default="scope">
            <el-switch
              :model-value="scope.row.status === 'active'"
              @change="toggleStatus(scope.row)"
            />
          </template>
        </el-table-column>

        <el-table-column :label="t('mcp.last_used_at')" width="180">
          <template #default="scope">{{ formatDate(scope.row.last_used_at) }}</template>
        </el-table-column>

        <el-table-column :label="t('mcp.created_at')" width="180">
          <template #default="scope">{{ formatDate(scope.row.created_at) }}</template>
        </el-table-column>

        <el-table-column fixed="right" :label="t('ds.actions')" width="160">
          <template #default="scope">
            <el-tooltip
              :offset="12"
              effect="dark"
              :content="t('mcp.connection_guide')"
              placement="top"
            >
              <el-icon
                size="16"
                class="hover-icon_with_bg action-icon"
                @click="openGuide(scope.row)"
              >
                <icon_visible_outlined></icon_visible_outlined>
              </el-icon>
            </el-tooltip>
            <el-tooltip :offset="12" effect="dark" :content="t('dashboard.edit')" placement="top">
              <el-icon
                size="16"
                class="hover-icon_with_bg action-icon"
                @click="openEdit(scope.row)"
              >
                <IconOpeEdit></IconOpeEdit>
              </el-icon>
            </el-tooltip>
            <el-tooltip :offset="12" effect="dark" :content="t('dashboard.delete')" placement="top">
              <el-icon
                size="16"
                class="hover-icon_with_bg action-icon"
                @click="deleteHandler(scope.row)"
              >
                <IconOpeDelete></IconOpeDelete>
              </el-icon>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-drawer
      v-model="dialogVisible"
      :title="dialogTitle"
      destroy-on-close
      size="520px"
      :before-close="closeForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item prop="name" :label="t('mcp.name')">
          <el-input
            v-model="form.name"
            :placeholder="t('mcp.name_required')"
            maxlength="100"
            clearable
            autocomplete="off"
          />
        </el-form-item>
        <el-form-item prop="description" :label="t('mcp.description')">
          <el-input
            v-model="form.description"
            type="textarea"
            :autosize="{ minRows: 3 }"
            maxlength="500"
            :placeholder="t('mcp.description')"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button secondary @click="closeForm">{{ $t('common.cancel') }}</el-button>
          <el-button type="primary" @click="save">{{ $t('common.save') }}</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog
      v-model="tokenDialogVisible"
      :title="t('mcp.token_dialog_title')"
      width="600px"
      destroy-on-close
    >
      <div class="token-warning">{{ t('mcp.token_warning') }}</div>
      <div class="token-box">
        <div class="token-meta">{{ issuedName }}</div>
        <code class="token-value">{{ issuedToken }}</code>
      </div>
      <template #footer>
        <el-button secondary @click="tokenDialogVisible = false">{{
          $t('common.cancel')
        }}</el-button>
        <el-button type="primary" @click="copyValue(issuedToken)">
          {{ t('mcp.copy_token') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="guideVisible"
      :title="t('mcp.connection_guide')"
      width="720px"
      destroy-on-close
    >
      <div class="guide-block">
        <div class="guide-label">{{ t('mcp.endpoint') }}</div>
        <div class="guide-value">
          <code>{{ endpoint }}</code>
          <el-button text @click="copyValue(endpoint)">{{ t('mcp.copy') }}</el-button>
        </div>
      </div>
      <div class="guide-block">
        <div class="guide-label">{{ t('mcp.client_config') }}</div>
        <pre class="guide-code">{{ guideJson }}</pre>
        <el-button text @click="copyGuide">{{ t('mcp.copy') }}</el-button>
      </div>
      <div class="guide-block">
        <div class="guide-label">{{ t('mcp.available_tools') }}</div>
        <div class="tool-tags">
          <el-tag v-for="tool in tools" :key="tool" type="info" size="small">{{ tool }}</el-tag>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style lang="less" scoped>
.mcp-page {
  height: 100%;
  position: relative;

  .tool-left {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;

    .title-block {
      display: flex;
      flex-direction: column;
      gap: 4px;

      .page-title {
        font-weight: 500;
        font-size: 20px;
        line-height: 28px;
      }

      .page-subtitle {
        font-size: 12px;
        line-height: 20px;
        color: #646a73;
      }
    }

    .tool-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: none;
    }
  }

  .table-content {
    max-height: calc(100% - 104px);
    overflow-y: auto;

    .name-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .name {
        font-weight: 500;
      }

      .desc {
        font-size: 12px;
        color: #646a73;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .value-cell {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .ellipsis {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hover-icon_with_bg {
      cursor: pointer;
      color: #646a73;

      &:hover {
        color: var(--ed-color-primary, #1cba90);
      }
    }

    .action-icon {
      margin-right: 12px;
    }
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
  }

  .token-warning {
    margin-bottom: 16px;
    padding: 10px 12px;
    border-radius: 6px;
    background: #fff7e6;
    color: #ad6800;
    font-size: 12px;
    line-height: 20px;
  }

  .token-box {
    padding: 12px;
    border: 1px solid #d9dcdf;
    border-radius: 6px;
    background: #f7f8fa;

    .token-meta {
      margin-bottom: 8px;
      font-weight: 500;
    }

    .token-value {
      display: block;
      word-break: break-all;
      font-family: monospace;
      font-size: 12px;
      line-height: 18px;
    }
  }

  .guide-block {
    margin-bottom: 20px;

    .guide-label {
      margin-bottom: 8px;
      font-weight: 500;
    }

    .guide-value {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid #d9dcdf;
      border-radius: 6px;
      background: #f7f8fa;

      code {
        flex: 1;
        word-break: break-all;
        font-family: monospace;
        font-size: 12px;
      }
    }

    .guide-code {
      margin: 0;
      padding: 12px;
      border: 1px solid #d9dcdf;
      border-radius: 6px;
      background: #f7f8fa;
      font-family: monospace;
      font-size: 12px;
      line-height: 18px;
      white-space: pre-wrap;
      word-break: break-all;
    }
  }

  .tool-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>
