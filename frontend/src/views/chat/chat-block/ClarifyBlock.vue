<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatRecord } from '@/api/chat.ts'

/** Clarify card (MetaDataImprove M1 rule 1): when the backend pauses a record
 *  with ambiguous candidate tables, offer the candidate list + a supplement
 *  input + a skip button. The parent (ChartAnswer) resumes the record via
 *  POST /chat/record/:rid/clarify; once answered/skipped the card collapses
 *  into a one-line summary so history reloads stay readable. */
interface ClarifyCandidate {
  table_id: number
  table_name: string
  comment: string
  /** Effective table semantic; preferred over comment when present. */
  meaning?: string
}

interface ClarifyPayload {
  /** Pause token: sent back with the answer so the backend can reject a
   *  stale/duplicated submit instead of running the pipeline twice. */
  round?: number
  question?: string
  candidates?: ClarifyCandidate[]
  max_select?: number
  /** The LLM's explanation for a need_clarify pause. */
  reason?: string
  /** Advisory preselection (current schema + LLM-named tables). */
  suggested_table_ids?: number[]
}

const props = defineProps<{ record: ChatRecord }>()
const emit = defineEmits<{
  (
    e: 'answer',
    body: { table_ids?: number[]; text?: string; skip?: boolean; round?: number }
  ): void
}>()

const { t } = useI18n()

const payload = computed<ClarifyPayload>(() => {
  const c = props.record.clarify
  if (typeof c === 'string') {
    try {
      return JSON.parse(c) as ClarifyPayload
    } catch {
      return {}
    }
  }
  return (c as ClarifyPayload) ?? {}
})

const candidates = computed<ClarifyCandidate[]>(() =>
  Array.isArray(payload.value.candidates) ? payload.value.candidates : []
)

const maxSelect = computed(() => Math.max(1, payload.value.max_select ?? 3))

const suggestedList = computed<number[]>(() =>
  Array.isArray(payload.value.suggested_table_ids) ? payload.value.suggested_table_ids : []
)
const suggestedIds = computed(() => new Set(suggestedList.value))

const pending = computed(() => props.record.clarify_status === 'pending')

// Preselect the backend's suggestion (current schema + LLM-named tables),
// clamped to the offered candidates and max_select. The user can still edit.
const selected = ref<number[]>(
  suggestedList.value
    .filter((id) => candidates.value.some((c) => c.table_id === id))
    .slice(0, maxSelect.value)
)
const supplement = ref('')

/** A multi-round pause replaces `record.clarify` on the SAME component (the
 *  parent reuses this record), so setup-time state would leak into round 2:
 *  stale picks may no longer be candidates (400) and the previous supplement
 *  would be submitted again. Reset whenever a new payload arrives. */
watch(payload, () => {
  selected.value = suggestedList.value
    .filter((id) => candidates.value.some((c) => c.table_id === id))
    .slice(0, maxSelect.value)
  supplement.value = ''
})

const canSubmit = computed(() => selected.value.length > 0 || supplement.value.trim().length > 0)

function submit() {
  if (!canSubmit.value) return
  emit('answer', {
    table_ids: selected.value.length > 0 ? [...selected.value] : undefined,
    text: supplement.value.trim() || undefined,
    round: payload.value.round,
  })
}

function skip() {
  emit('answer', { skip: true, round: payload.value.round })
}

/** Collapsed summary after the round is settled (answered / skipped). */
const summary = computed<string>(() => {
  const a = props.record.clarify_answer
  if (!a || typeof a !== 'object') return ''
  if (a.skip) return t('chat.clarify_answered_skip')
  const parts: string[] = []
  if (Array.isArray(a.table_names) && a.table_names.length > 0) {
    parts.push(t('chat.clarify_answered_tables', [a.table_names.join('、')]))
  }
  if (typeof a.text === 'string' && a.text.trim()) {
    parts.push(t('chat.clarify_answered_text', [a.text.trim()]))
  }
  return parts.join('；')
})
</script>

<template>
  <div v-if="record.clarify" class="clarify-block">
    <template v-if="pending">
      <div class="clarify-title">{{ t('chat.clarify_title') }}</div>
      <div class="clarify-hint">
        {{ t('chat.clarify_hint', [maxSelect]) }}
      </div>
      <div v-if="payload.reason" class="clarify-reason">
        <span class="reason-label">{{ t('chat.clarify_reason_label') }}</span>
        {{ payload.reason }}
      </div>
      <el-checkbox-group v-model="selected" class="clarify-candidates">
        <el-checkbox
          v-for="c in candidates"
          :key="c.table_id"
          :value="c.table_id"
          :disabled="selected.length >= maxSelect && !selected.includes(c.table_id)"
        >
          <span class="candidate-name">{{ c.table_name }}</span>
          <span v-if="c.meaning" class="candidate-meaning">{{ c.meaning }}</span>
          <span v-else-if="c.comment" class="candidate-comment">{{ c.comment }}</span>
          <el-tag v-if="suggestedIds.has(c.table_id)" size="small" class="candidate-suggested">
            {{ t('chat.clarify_suggested') }}
          </el-tag>
        </el-checkbox>
      </el-checkbox-group>
      <el-input
        v-model="supplement"
        type="textarea"
        :rows="2"
        maxlength="200"
        :placeholder="t('chat.clarify_supplement_placeholder')"
      />
      <div class="clarify-actions">
        <el-button type="primary" size="small" :disabled="!canSubmit" @click="submit">
          {{ t('chat.clarify_submit') }}
        </el-button>
        <el-button size="small" @click="skip">
          {{ t('chat.clarify_skip') }}
        </el-button>
      </div>
    </template>
    <div v-else-if="summary" class="clarify-summary">
      {{ summary }}
    </div>
  </div>
</template>

<style scoped lang="less">
.clarify-block {
  width: 100%;
  margin-top: 6px;
  padding: 12px 16px;
  border: 1px solid rgba(222, 224, 227, 1);
  border-radius: 8px;
  background: rgba(245, 246, 247, 0.6);

  .clarify-title {
    font-weight: 500;
    font-size: 14px;
    line-height: 22px;
    color: rgba(31, 35, 41, 1);
  }

  .clarify-hint {
    margin-top: 4px;
    font-size: 12px;
    line-height: 20px;
    color: rgba(143, 149, 158, 1);
  }

  .clarify-reason {
    margin-top: 2px;
    font-size: 12px;
    line-height: 20px;
    color: rgba(143, 149, 158, 1);

    .reason-label {
      margin-right: 4px;
      font-weight: 500;
    }
  }

  .clarify-candidates {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    max-height: 220px;
    overflow-y: auto;

    .candidate-name {
      font-weight: 500;
    }

    .candidate-comment,
    .candidate-meaning {
      margin-left: 8px;
      color: rgba(143, 149, 158, 1);
      font-weight: 400;
    }

    .candidate-suggested {
      margin-left: 6px;
    }
  }

  .clarify-actions {
    margin-top: 10px;
    display: flex;
    flex-direction: row;
    gap: 8px;
  }

  .clarify-summary {
    font-size: 13px;
    line-height: 20px;
    color: rgba(143, 149, 158, 1);
  }
}
</style>
