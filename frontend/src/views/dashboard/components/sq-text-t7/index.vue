<template>
  <div class="rich-text-editor">
    <editor v-model="content" :init="initOptions" @on-init="handleInit" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { CN_FONT_BLOCK, LATIN_FONT_BLOCK, isZh } from '@/components/rich-text/fonts'
import { i18n } from '@/i18n'
import Editor from '@tinymce/tinymce-vue'

defineProps({
  modelValue: {
    type: String,
    default: '',
  },
})

const content = ref(i18n.global.t('dashboard.sample_text'))
const editorRef = ref(null)

const initOptions = {
  base_url: '/tinymce', // 指向 public/tinymce 目录
  suffix: '.min',
  height: 500,
  menubar: false,
  language: isZh() ? 'zh_CN' : 'en',
  skin: 'oxide', // 皮肤
  plugins: [
    'advlist',
    'autolink',
    'lists',
    'link',
    'image',
    'preview',
    'anchor',
    'searchreplace',
    'visualblocks',
    'code',
    'fullscreen',
    'insertdatetime',
    'media',
    'table',
  ],
  inline: true,
  font_formats: (isZh() ? CN_FONT_BLOCK : '') + LATIN_FONT_BLOCK,
  fontsize_formats:
    '12px 14px 16px 18px 20px 22px 24px 28px 32px 36px 42px 48px 56px 72px 80px 90px 100px 110px 120px 140px 150px 170px 190px 210px',
  toolbar:
    'undo redo | fontselect fontsizeselect | blocks | bold italic forecolor | alignleft aligncenter alignright alignjustify',
  content_style: 'body { font-family:Helvetica,Arial,sans-serif; font-size:14px }',
}
const handleInit = (editor: any) => {
  editorRef.value = editor
  console.info('TinyMCE 初始化完成', editor)
}
</script>

<style scoped>
.rich-text-editor {
  margin: 20px 0;
}
</style>
