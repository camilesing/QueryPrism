import { IsIn } from 'class-validator';

export class UpdateLanguageDto {
  @IsIn(['en', 'zh-CN'])
  language!: 'en' | 'zh-CN';
}
