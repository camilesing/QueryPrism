<template>
  <div>
    <h1>{{ $t('dashboard.article_editor') }}</h1>
    <RichTextEditor v-model="articleContent" />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import RichTextEditor from '@/views/dashboard/components/sq-text-t7/index.vue'
const articleContent = ref('<p>...</p>')
</script>

<style>
.preview {
  margin-top: 20px;
  padding: 15px;
  border: 1px solid #eee;
  border-radius: 6px;
}
</style>
