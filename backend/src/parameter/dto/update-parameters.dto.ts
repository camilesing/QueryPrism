import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { UpdateParameterItemDto } from './update-parameter-item.dto';

export class UpdateParametersDto {
  @ValidateNested({ each: true })
  @Type(() => UpdateParameterItemDto)
  variables!: UpdateParameterItemDto[];
}
