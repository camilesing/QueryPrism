<template>
  <div ref="loginContainer" class="login-container">
    <div class="login-lang">
      <language-selector />
    </div>
    <div v-if="showLoginImage" class="login-image-content">
      <el-image v-if="appearanceStore.getBg" class="login-image" fit="cover" :src="bg" />
      <div v-else class="login-panel-dark">
        <div class="panel-logo">{{ appearanceStore.name || 'QueryPrism' }}</div>
        <div class="panel-slogan">
          {{ appearanceStore.slogan || $t('common.intelligent_questioning_platform') }}
        </div>
      </div>
    </div>
    <div class="login-content">
      <div class="login-right">
        <div class="login-logo-icon">
          <img v-if="loginBg" height="52" :src="loginBg" alt="" />
          <el-icon v-else size="52"
            ><custom_small v-if="appearanceStore.themeColor !== 'default'"></custom_small>
            <LOGO_fold v-else></LOGO_fold
          ></el-icon>
          <span style="margin-left: 14px; font-size: 34px; font-weight: 900; color: #0f172a">{{
            appearanceStore.name
          }}</span>
        </div>
        <div v-if="appearanceStore.getShowSlogan" class="welcome">
          {{ appearanceStore.slogan ?? $t('common.intelligent_questioning_platform') }}
        </div>
        <div v-else class="welcome" style="height: 0"></div>
        <div class="login-form">
          <div class="default-login-tabs">
            <h2 class="title">{{ $t('common.login') }}</h2>
            <el-form
              ref="loginFormRef"
              class="form-content_error"
              :model="loginForm"
              :rules="rules"
              @keyup.enter="submitForm"
            >
              <el-form-item prop="username">
                <el-input
                  v-model="loginForm.username"
                  clearable
                  :placeholder="$t('login.input_account')"
                  size="large"
                ></el-input>
              </el-form-item>
              <el-form-item prop="password">
                <el-input
                  v-model="loginForm.password"
                  :placeholder="$t('common.enter_your_password')"
                  type="password"
                  show-password
                  clearable
                  size="large"
                ></el-input>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" class="login-btn" @click="submitForm">{{
                  $t('common.login_')
                }}</el-button>
              </el-form-item>
            </el-form>
          </div>
          <InitialPwdDialog
            v-model="initPwdDialogVisible"
            :account="loginForm.username"
            :old-pwd="loginForm.password"
            @pwd-saved="onInitPwdSaved"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useI18n } from 'vue-i18n'
import custom_small from '@/assets/svg/logo-custom_small.svg'
import LOGO_fold from '@/assets/LOGO-fold.svg'
import { useAppearanceStoreWithOut } from '@/stores/appearance'
import InitialPwdDialog from './InitialPwdDialog.vue'
import { toLoginSuccess } from '@/utils/utils'
import elementResizeDetectorMaker from 'element-resize-detector'

const router = useRouter()
const userStore = useUserStore()
const appearanceStore = useAppearanceStoreWithOut()
const { t } = useI18n()
const loginForm = ref({
  username: '',
  password: '',
})
const bg = computed(() => {
  return appearanceStore.getBg || ''
})

const loginBg = computed(() => {
  return appearanceStore.getLogin
})
const loginContainerWidth = ref(0)
const loginContainer = ref()
const showLoginImage = computed<boolean>(() => {
  return !(loginContainerWidth.value < 889)
})

onMounted(async () => {
  const erd = elementResizeDetectorMaker()
  erd.listenTo(loginContainer.value, () => {
    nextTick(() => {
      loginContainerWidth.value = loginContainer.value?.offsetWidth
    })
  })
})
const rules = {
  username: [{ required: true, message: t('common.your_account_email_address'), trigger: 'blur' }],
  password: [{ required: true, message: t('common.the_correct_password'), trigger: 'blur' }],
}

const loginFormRef = ref()

// When the backend answers need_change_pwd (empty token,
// login.initial_pwd_disabled=true + the account still uses the initial
// password), force the InitialPwdDialog instead of entering the app. On
// pwd-saved the new password is backfilled into the form so the next
// submit logs in with it (the user re-submits, no
// silent auto-login).
const initPwdDialogVisible = ref(false)
const submitForm = () => {
  loginFormRef.value.validate((valid: boolean) => {
    if (valid) {
      userStore.login(loginForm.value).then((res: any) => {
        if (res?.need_change_pwd) {
          initPwdDialogVisible.value = true
          return
        }
        toLoginSuccess(router)
      })
    }
  })
}
const onInitPwdSaved = (newPwd: string) => {
  loginForm.value.password = newPwd
}
</script>

<style lang="less" scoped>
.login-container {
  position: relative;
  height: 100vh;
  width: 100vw;
  background-color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;

  .login-lang {
    position: absolute;
    top: 16px;
    right: 24px;
    z-index: 10;
  }

  .login-image-content {
    overflow: hidden;
    height: 100%;
    width: 40%;
    min-width: 400px;
    .login-image {
      background-size: 100% 100%;
      width: 100%;
      height: 100%;
    }
  }

  .login-panel-dark {
    background: linear-gradient(160deg, #1e293b 0%, #0f172a 100%);
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 0 48px;

    .panel-logo {
      color: #f8fafc;
      font-size: 34px;
      font-weight: 900;
      border-left: 3px solid #f97316;
      padding-left: 14px;
    }

    .panel-slogan {
      color: #94a3b8;
      font-size: 14px;
      margin-top: 12px;
      padding-left: 17px;
    }
  }

  .login-content {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;

    .login-right {
      display: flex;
      align-items: center;
      flex-direction: column;
      position: relative;

      .login-logo-icon {
        width: auto;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .welcome {
        margin: 8px 0 40px 0;
        font-weight: 400;
        font-size: 14px;
        line-height: 20px;
        color: #646a73;
      }

      .login-form {
        border: 1px solid #cbd5e1;
        padding: 40px;
        width: 480px;
        min-height: 392px;
        border-radius: 6px;
        box-shadow: var(--shadow);

        .form-content_error {
          .ed-form-item--default {
            margin-bottom: 24px;
            &.is-error {
              margin-bottom: 48px;
            }
          }
        }

        .title {
          font-weight: 500;
          font-style: Medium;
          font-size: 20px;
          line-height: 28px;
          margin-bottom: 24px;
        }

        .login-btn {
          width: 100%;
          height: 40px;
          font-size: 16px;
          border-radius: 6px;
        }

        .agreement {
          margin-top: 20px;
          text-align: center;
          color: #666;
        }
      }
    }
  }
}
</style>
