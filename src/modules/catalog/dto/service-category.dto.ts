import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServiceDto } from './service.dto';

/** Swagger-only mirror of the Prisma ServiceCategory model. */
export class ServiceCategoryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'home-cleaning' })
  slug: string;

  @ApiPropertyOptional({ nullable: true })
  iconUrl: string | null;

  @ApiProperty({ description: 'Ascending. Ties break on name.' })
  sortOrder: number;

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null for a root category. Only roots may have children.',
  })
  parentCategoryId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/**
 * One node of the browse tree. Exactly two levels deep: a root carries
 * `children`, a child never does.
 */
export class CategoryTreeNodeDto extends ServiceCategoryDto {
  @ApiProperty({
    type: () => [CategoryTreeNodeDto],
    description: 'Always empty on a child category.',
  })
  children: CategoryTreeNodeDto[];

  @ApiProperty({
    type: () => [ServiceDto],
    description: 'Active services filed directly under this category.',
  })
  services: ServiceDto[];
}
