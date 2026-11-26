<script lang="ts" setup>
import { onMounted, provide, reactive, ref, unref } from 'vue'
import icon_info_outlined_1 from '@/assets/svg/icon_info_outlined_1.svg'
import { useI18n } from 'vue-i18n'
import { request } from '@/utils/request'
import { formatArg } from '@/utils/utils'
const { t } = useI18n()

// 9e6070e8：检索策略参数（embedding.*）。默认值与后端代码默认一致；页面加载后
// 由后端返回的有效值（已保存 > 启动配置 > 代码默认）覆盖。
// MetaDataImprove M1：clarify.* 反问收敛参数走同一注册表与校验链路。
// 表召回宽度（embedding.table_top_k）与 join 桥接跳数（join.bridge_max_hops）
// 也是同一注册表里的运行时参数；关键词抽取始终开启，不是参数。
const EMBEDDING_NUMBER_KEYS = [
  'embedding.table_alpha',
  'embedding.table_top_k',
  'embedding.datasource_count',
  'clarify.table_threshold',
  'clarify.max_select',
  'clarify.max_rounds',
  'semantic.max_tables',
  'metric.max_definitions',
  'join.bridge_max_hops',
  // MetaDataImprove M7: query-cost keys
  'quota.max_rows',
  'cache.ttl_seconds',
]

const state = reactive({
  parameterForm: reactive<any>({
    'chat.queryprism_name': 'QueryPrism',
    'chat.hide_thinking_block': false,
    'chat.expand_thinking_block': false,
    'chat.limit_rows': false,
    'chat.show_sql': false,
    'chat.show_log': false,
    'chat.sample_data_enabled': true,
    'embedding.table_enabled': true,
    'embedding.table_alpha': 0.4,
    'embedding.table_top_k': 3,
    'embedding.datasource_count': 10,
    'clarify.enabled': true,
    'clarify.table_threshold': 3,
    'clarify.max_select': 3,
    'clarify.max_rounds': 1,
    'semantic.enabled': true,
    'semantic.max_tables': 3,
    'metric.enabled': true,
    'metric.max_definitions': 5,
    'naming.enabled': true,
    'join.bridge_max_hops': 2,
    // MetaDataImprove M7: query-cost keys (defaults mirror the backend).
    'quota.max_rows': 1000,
    'cache.enabled': false,
    'cache.ttl_seconds': 300,
    'login.initial_pwd_disabled': false,
    'login.initial_pwd_hidden': false,
  }),
})
provide('parameterForm', state.parameterForm)
// Save stays disabled until the stored values have actually loaded: the form
// starts from hardcoded defaults, and saving those before/without a
// successful GET would overwrite the admin's stored retrieval strategy and
// login policy with defaults.
const loaded = ref(false)
const loadData = () => {
  request.get('/system/parameter').then(
    (res: any) => {
      if (res) {
        res.forEach((item: any) => {
          if (
            item.pkey?.startsWith('chat') ||
            item.pkey?.startsWith('login') ||
            item.pkey?.startsWith('embedding') ||
            item.pkey?.startsWith('clarify') ||
            item.pkey?.startsWith('semantic') ||
            item.pkey?.startsWith('metric') ||
            item.pkey?.startsWith('naming') ||
            item.pkey?.startsWith('join') ||
            item.pkey?.startsWith('quota') ||
            item.pkey?.startsWith('cache')
          ) {
            if (item.pkey === 'chat.queryprism_name') {
              if (item.pval && item.pval.trim().length > 0) {
                state.parameterForm[item.pkey] = item.pval
              }
            } else if (EMBEDDING_NUMBER_KEYS.includes(item.pkey)) {
              const n = Number(item.pval)
              if (Number.isFinite(n)) {
                state.parameterForm[item.pkey] = n
              }
            } else {
              state.parameterForm[item.pkey] = formatArg(item.pval)
            }
          }
        })
      }
      loaded.value = true
    },
    // The axios interceptor already surfaces the error; here it only has to
    // keep Save disabled so defaults can never be saved over stored rows.
    () => undefined
  )
}

const onContextRecordCountChange = (count: number) => {
  if (count < 0) {
    state.parameterForm['chat.context_record_count'] = 0
  }
  state.parameterForm['chat.context_record_count'] = Math.floor(count)
}

const beforeChange = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!state.parameterForm['chat.limit_rows']) {
      return resolve(true)
    }
    ElMessageBox.confirm(t('parameter.excessive_data_volume'), t('parameter.prompt'), {
      confirmButtonType: 'primary',
      confirmButtonText: t('common.confirm2'),
      cancelButtonText: t('common.cancel'),
      customClass: 'confirm-no_icon confirm_no_icon_parameter',
      autofocus: false,
      callback: (action: any) => {
        resolve(action && action === 'confirm')
      },
    })
  })
}
const buildParam = () => {
  const changedItemArray = Object.keys(state.parameterForm).map((key: string) => {
    return {
      pkey: key,
      // The backend rejects non-string pval with 400, so every form value is
      // stringified. `?? ''` — a cleared el-input-number yields null and
      // String(null) would send 'null'.
      pval: String(state.parameterForm[key] ?? ''),
    }
  })
  const formData = new FormData()
  formData.append('data', JSON.stringify(unref(changedItemArray)))
  return formData
}
const saveHandler = () => {
  const param = buildParam()
  request
    .post('/system/parameter', param, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    })
    .then(() => {
      ElMessage.success(t('common.save_success'))
    })
}
onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="parameter">
    <div class="title">
      {{ t('parameter.parameter_configuration') }}
    </div>
    <div class="card-container">
      <div class="card">
        <div class="card-title">
          {{ t('parameter.question_count_settings') }}
        </div>
        <el-row>
          <div class="card-item" style="width: 100%">
            <div class="label">
              {{ t('parameter.queryprism_name') }}
            </div>
            <div class="value">
              <el-input v-model="state.parameterForm['chat.queryprism_name']" />
            </div>
          </div>
        </el-row>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.hide_model_thinking_process') }}
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['chat.hide_thinking_block']" />
            </div>
          </div>
          <div v-if="!state.parameterForm['chat.hide_thinking_block']" class="card-item">
            <div class="label">
              {{ t('parameter.model_thinking_process') }}

              <el-tooltip effect="dark" :content="t('parameter.closed_by_default')" placement="top">
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['chat.expand_thinking_block']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.rows_of_data') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.excessive_data_volume')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch
                v-model="state.parameterForm['chat.limit_rows']"
                :before-change="beforeChange"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.show_sql') }}
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['chat.show_sql']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.show_log') }}
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['chat.show_log']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.sample_data_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.sample_data_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['chat.sample_data_enabled']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.context_record_count') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.context_record_count_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['chat.context_record_count']"
                min="0"
                step="1"
                @change="onContextRecordCountChange"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          {{ t('parameter.retrieval_strategy_settings') }}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.embedding_table_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.embedding_table_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['embedding.table_enabled']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.embedding_table_alpha') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.embedding_table_alpha_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['embedding.table_alpha']"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                controls-position="right"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.embedding_table_top_k') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.embedding_table_top_k_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['embedding.table_top_k']"
                :min="1"
                :max="100"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.embedding_datasource_count') }}
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['embedding.datasource_count']"
                :min="1"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          {{ t('parameter.clarify_settings') }}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.clarify_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.clarify_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['clarify.enabled']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.clarify_table_threshold') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.clarify_table_threshold_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['clarify.table_threshold']"
                :min="1"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.clarify_max_select') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.clarify_max_select_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['clarify.max_select']"
                :min="1"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.clarify_max_rounds') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.clarify_max_rounds_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['clarify.max_rounds']"
                :min="1"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          {{ t('parameter.semantic_enabled') }}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.semantic_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.semantic_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['semantic.enabled']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.semantic_max_tables') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.semantic_max_tables_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['semantic.max_tables']"
                :min="1"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          {{ t('parameter.join_bridge_settings') }}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.join_bridge_max_hops') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.join_bridge_max_hops_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['join.bridge_max_hops']"
                :min="1"
                :max="5"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          {{ t('parameter.metric_settings') }}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.metric_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.metric_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['metric.enabled']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.metric_max_definitions') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.metric_max_definitions_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['metric.max_definitions']"
                :min="1"
                step="1"
                controls-position="right"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.naming_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.naming_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['naming.enabled']" />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">{{ t('parameter.query_cost_settings') }}</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr">
          <div class="card-item">
            <div class="label">
              {{ t('parameter.quota_max_rows') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.quota_max_rows_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['quota.max_rows']"
                :min="1"
                :max="100000"
                controls-position="right"
              />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.cache_enabled') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.cache_enabled_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-switch v-model="state.parameterForm['cache.enabled']" />
            </div>
          </div>
          <div class="card-item">
            <div class="label">
              {{ t('parameter.cache_ttl_seconds') }}
              <el-tooltip
                effect="dark"
                :content="t('parameter.cache_ttl_seconds_hint')"
                placement="top"
              >
                <el-icon size="16">
                  <icon_info_outlined_1></icon_info_outlined_1>
                </el-icon>
              </el-tooltip>
            </div>
            <div class="value">
              <el-input-number
                v-model.number="state.parameterForm['cache.ttl_seconds']"
                :min="1"
                :max="86400"
                controls-position="right"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">{{ t('parameter.login_settings') }}</div>
        <div class="card-item" style="width: 100%">
          <div class="label">{{ t('parameter.disable_initial_password') }}</div>
          <div class="value">
            <el-switch v-model="state.parameterForm['login.initial_pwd_disabled']" />
          </div>
        </div>
        <div class="card-item" style="width: 100%">
          <div class="label">{{ t('parameter.hide_initial_password') }}</div>
          <div class="value">
            <el-switch v-model="state.parameterForm['login.initial_pwd_hidden']" />
          </div>
        </div>
      </div>
    </div>
    <div class="save" style="margin-top: 16px">
      <el-button type="primary" :disabled="!loaded" @click="saveHandler">{{
        t('common.save')
      }}</el-button>
    </div>
  </div>
</template>
<style lang="less">
.confirm_no_icon_parameter {
  .ed-message-box__header {
    margin-bottom: var(--ed-messagebox-padding-primary);
  }
  .ed-message-box__message > p {
    font-size: 14px;
    font-weight: 400;
    line-height: 22px;
  }
}
</style>
<style lang="less" scoped>
.parameter {
  :deep(.ed-radio) {
    --ed-radio-input-height: 16px;
    --ed-radio-input-width: 16px;
  }
  .title {
    font-weight: 500;
    font-size: 20px;
    line-height: 28px;
    margin-bottom: 16px;
  }
  .card-container {
    .card {
      width: 100%;
      border-radius: 12px;
      padding: 16px;
      border: 1px solid #dee0e3;
      display: flex;
      flex-direction: column;
      margin-top: 16px;

      .card-title {
        font-weight: 500;
        font-size: 16px;
        line-height: 24px;
        width: 100%;
      }
      .card-item {
        margin-top: 16px;
        width: calc(50% - 8px);
        .label {
          font-weight: 400;
          font-size: 14px;
          line-height: 22px;
          display: flex;
          align-items: center;

          .ed-icon {
            margin-left: 4px;
          }

          .require::after {
            content: '*';
            color: var(--ed-color-danger);
            margin-left: 4px;
          }
        }

        .value {
          margin-top: 8px;
          line-height: 20px;
        }
      }
    }
  }
}
</style>
