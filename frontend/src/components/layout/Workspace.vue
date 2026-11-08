<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'
import icon_expand_down_filled from '@/assets/svg/icon_expand-down_filled.svg'
import icon_moments_categories_outlined from '@/assets/svg/icon_moments-categories_outlined.svg'
import icon_done_outlined from '@/assets/svg/icon_done_outlined.svg'
import icon_searchOutline_outlined from '@/assets/svg/icon_search-outline_outlined.svg'
import { userApi } from '@/api/auth'
import { ElMessage } from 'element-plus-secondary'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { highlightKeyword } from '@/utils/xss'

const userStore = useUserStore()
const { t } = useI18n()
defineProps({
  collapse: { type: [Boolean], required: true },
})

const router = useRouter()
const currentWorkspace = ref({
  id: '',
  name: '',
})
const defaultDatasourceList = ref([] as any[])
const workspaceKeywords = ref('')
const wsLoading = ref(false)
const defaultWorkspaceListWithSearch = computed(() => {
  if (!workspaceKeywords.value) return defaultDatasourceList.value
  return defaultDatasourceList.value.filter((ele) =>
    ele.name.toLowerCase().includes(workspaceKeywords.value.toLowerCase())
  )
})
const formatKeywords = (item: string) => {
  // Use XSS-safe highlight function
  return highlightKeyword(item, workspaceKeywords.value, 'isSearch')
}

const emit = defineEmits(['selectWorkspace'])

const handleDefaultWorkspaceChange = (item: any) => {
  if (currentWorkspace.value?.id && item.id.toString() === currentWorkspace.value.id.toString()) {
    return
  }
  currentWorkspace.value = { id: item.id, name: item.name }
  userApi.ws_change(item.id).then(() => {
    ElMessage.success(t('common.switch_success'))
    router.push('/chat/index')
    setTimeout(() => {
      location.reload()
    }, 300)
  })
  emit('selectWorkspace', item)
}

const init_ws_data = async () => {
  wsLoading.value = true
  try {
    defaultDatasourceList.value = await userApi.ws_options()
  } finally {
    wsLoading.value = false
  }
}

const init_current_ws = () => {
  const oid = userStore.getOid
  currentWorkspace.value = defaultDatasourceList.value.find(
    (item) => item.id.toString() === oid.toString()
  ) || {
    id: oid,
    name: '',
  }
}
onMounted(async () => {
  await init_ws_data()
  init_current_ws()
})
</script>

<template>
  <el-popover
    trigger="click"
    popper-class="system-workspace"
    :placement="collapse ? 'right' : 'bottom'"
  >
    <template #reference>
      <button class="workspace" :class="collapse && 'collapse'">
        <el-icon size="18">
          <icon_moments_categories_outlined></icon_moments_categories_outlined>
        </el-icon>
        <span v-if="!collapse" :title="currentWorkspace?.name || ''" class="name ellipsis">{{
          currentWorkspace?.name || ''
        }}</span>
        <el-icon v-if="!collapse" style="transform: scale(0.5)" class="expand" size="24">
          <icon_expand_down_filled></icon_expand_down_filled>
        </el-icon></button
    ></template>
    <div class="popover">
      <el-input
        v-model="workspaceKeywords"
        clearable
        class="workspace-search"
        :placeholder="$t('datasource.search_by_name')"
      >
        <template #prefix>
          <el-icon>
            <icon_searchOutline_outlined class="svg-icon" />
          </el-icon>
        </template>
      </el-input>
      <div v-loading="wsLoading" class="popover-content">
        <el-scrollbar max-height="400px">
          <div
            v-for="ele in defaultWorkspaceListWithSearch"
            :key="ele.id"
            class="popover-item"
            :class="currentWorkspace?.id === ele.id && 'isActive'"
            @click="handleDefaultWorkspaceChange(ele)"
          >
            <el-icon size="16">
              <icon_moments_categories_outlined></icon_moments_categories_outlined>
            </el-icon>
            <div
              :title="ele.name"
              class="datasource-name ellipsis"
              v-html="formatKeywords(ele.name)"
            ></div>
            <span v-if="ele.archived" class="archived-tag">{{ $t('workspace.archived') }}</span>
            <el-icon size="16" class="done">
              <icon_done_outlined></icon_done_outlined>
            </el-icon>
          </div>
        </el-scrollbar>

        <div v-if="!defaultWorkspaceListWithSearch.length" class="popover-item empty">
          {{ $t('model.relevant_results_found') }}
        </div>
      </div>
    </div>
  </el-popover>
</template>

<style lang="less" scoped>
.workspace {
  background: var(--chrome-hover, #334155);
  border-radius: 6px;
  border: 1px solid #475569;
  color: var(--chrome-text-strong, #f8fafc);
  padding: 0 12px;
  display: flex;
  align-items: center;
  cursor: pointer;
  width: 208px;
  height: 40px;
  margin-bottom: 12px;

  &.collapse {
    width: 40px;
    background: none;
    border: none;
  }

  .name {
    font-weight: 400;
    font-size: 14px;
    line-height: 22px;
    margin-left: 8px;
    max-width: 120px;
    color: var(--chrome-text-strong, #f8fafc);
  }

  .expand {
    margin-left: auto;
    color: var(--chrome-text-strong, #f8fafc);
  }

  &:hover {
    background: #475569;
  }

  &:active {
    background: #475569;
  }
}
</style>

<style lang="less">
.system-workspace.system-workspace {
  --ed-popover-border-radius: 6px;
  width: 280px !important;
  padding: 0;
  background: var(--white, #fff);
  border: 1px solid var(--border-color, #cbd5e1);
  border-radius: 6px;
  box-shadow:
    0 12px 32px rgba(15, 23, 42, 0.16),
    0 2px 6px rgba(15, 23, 42, 0.08);
  overflow: hidden;

  .popover {
    padding: 8px;

    .workspace-search {
      width: 100%;

      .ed-input__wrapper {
        height: 32px;
        padding: 0 8px;
        background: #f8fafc;
        border-radius: 6px;
        box-shadow: 0 0 0 1px var(--border-color, #cbd5e1) inset;
        transition:
          background-color 0.15s ease,
          box-shadow 0.15s ease;

        &:hover {
          box-shadow: 0 0 0 1px #94a3b8 inset;
        }

        &.is-focus {
          background: #fff;
          box-shadow: 0 0 0 1px var(--ed-color-primary, #2563eb) inset;
        }
      }

      .ed-input__inner {
        color: var(--text-color, #0f172a);
        font-size: 14px;

        &::placeholder {
          color: #94a3b8;
        }
      }

      .ed-input__prefix .ed-icon,
      .ed-input__suffix .ed-icon {
        color: #94a3b8;
      }
    }

    .popover-content {
      margin-top: 8px;

      .ed-loading-mask {
        border-radius: 6px;
        background-color: rgba(255, 255, 255, 0.75);
      }
    }

    .popover-item {
      height: 36px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      margin-bottom: 2px;
      position: relative;
      border-radius: 6px;
      color: #334155;
      cursor: pointer;
      transition:
        background-color 0.15s ease,
        color 0.15s ease;

      > .ed-icon {
        flex: 0 0 auto;
        color: #64748b;

        svg path {
          fill: currentColor;
        }
      }

      &:not(.empty):hover {
        background: #f1f5f9;
        color: #0f172a;
      }

      &.empty {
        height: 56px;
        justify-content: center;
        font-weight: 400;
        font-size: 14px;
        line-height: 22px;
        color: #94a3b8;
        cursor: default;
      }

      .datasource-name {
        margin-left: 8px;
        font-weight: 400;
        font-size: 14px;
        line-height: 22px;
        max-width: 150px;
      }

      .archived-tag {
        margin-left: 8px;
        padding: 0 6px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        background: #f1f5f9;
        color: #64748b;
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
      }

      .done {
        margin-left: auto;
        display: none;
        color: var(--ed-color-primary, #2563eb);

        svg path {
          fill: currentColor;
        }
      }

      .isSearch {
        color: var(--ed-color-primary, #2563eb);
        font-weight: 600;
      }

      &.isActive {
        background: var(--ed-color-primary-1a, rgba(37, 99, 235, 0.1));
        color: var(--ed-color-primary, #2563eb);
        font-weight: 500;

        > .ed-icon {
          color: var(--ed-color-primary, #2563eb);
        }

        .done {
          display: block;
        }

        // 选中项悬停时保持选中色，避免与普通项的 hover 态串色
        &:hover {
          background: var(--ed-color-primary-1a, rgba(37, 99, 235, 0.1));
          color: var(--ed-color-primary, #2563eb);
        }
      }
    }
  }
}
</style>
