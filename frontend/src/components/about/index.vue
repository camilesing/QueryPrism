<script lang="ts" setup>
// vite-svg-loader's defaultImport is 'component' — a bare import yields a Vue
// component object, not a URL. `?url` forces the asset URL for <img :src>.
import aboutBg from '@/assets/embedded/LOGO-about.svg?url'

import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const dialogVisible = ref(false)
const { t } = useI18n()
// QueryPrism has no licensing: the About dialog is a plain build/version card.
const build = ref('0.0.1')

const open = () => {
  dialogVisible.value = true
}
defineExpose({
  open,
})
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t('about.title')"
    width="840px"
    modal-class="about-dialog"
  >
    <div class="color-overlay flex-center">
      <img width="368" height="84" :src="aboutBg" />
    </div>
    <div class="content">
      <div class="item">
        <div class="label">{{ $t('about.version_num') }}</div>
        <div class="value">{{ build }}</div>
      </div>
      <div class="item">
        <div class="label">{{ $t('about.version') }}</div>
        <div class="value">{{ $t('about.standard') }}</div>
      </div>
    </div>
    <div class="name">2014-2026 版权所有 © 杭州飞致云信息科技有限公司</div>
  </el-dialog>
</template>

<style lang="less">
.about-dialog {
  .color-overlay {
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    background: var(--ed-color-primary-1a, #1cba901a);
    border: 1px solid #dee0e3;
    border-bottom: 0;
    height: 180px;
  }

  .name {
    font-weight: 400;
    font-size: 12px;
    line-height: 22px;
    text-align: center;
    margin-top: 16px;
    color: #8f959e;
  }

  .content {
    border-radius: 6px;
    border: 1px solid #dee0e3;
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-top: 0;
    padding: 24px 40px;

    .item {
      font-size: 16px;
      font-style: normal;
      font-weight: 400;
      line-height: 24px;
      margin-bottom: 16px;
      display: flex;
      .label {
        color: #646a73;
        width: 240px;
      }

      .value {
        margin-left: 24px;
        max-width: 448px;
      }
    }
  }
}
</style>
