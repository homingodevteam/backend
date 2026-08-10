import { ProProfilePhotoService } from './pro-profile-photo.service';

describe('ProProfilePhotoService', () => {
  it('stores only a generated key belonging to the authenticated Pro', async () => {
    const prisma = {
      pro: {
        update: jest.fn().mockResolvedValue({
          id: 'pro-1',
          profilePhotoUrl:
            'profile-photos/pro-1/123e4567-e89b-42d3-a456-426614174000',
        }),
      },
    };
    const service = new ProProfilePhotoService(prisma as never, {} as never);
    const key = 'profile-photos/pro-1/123e4567-e89b-42d3-a456-426614174000';

    await service.setPhoto('pro-1', key);

    expect(prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { profilePhotoUrl: key },
    });
  });

  it('rejects a key issued for a different Pro', async () => {
    const service = new ProProfilePhotoService({} as never, {} as never);

    await expect(
      service.setPhoto(
        'pro-1',
        'profile-photos/pro-2/123e4567-e89b-42d3-a456-426614174000',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 400 }),
    });
  });
});
