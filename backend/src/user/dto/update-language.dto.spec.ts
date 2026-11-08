import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateLanguageDto } from './update-language.dto';

describe('UpdateLanguageDto', () => {
  it.each(['en', 'zh-CN'])('accepts %s', async (language) => {
    const dto = plainToInstance(UpdateLanguageDto, { language });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each(['zh-TW', 'ko-KR', 'fr', 'en-US', ''])(
    'rejects %s',
    async (language) => {
      const dto = plainToInstance(UpdateLanguageDto, { language });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
