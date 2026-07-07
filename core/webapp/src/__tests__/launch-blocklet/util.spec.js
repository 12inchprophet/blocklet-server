import { describe, test, expect } from 'bun:test';
import { DEBOS_BLOCKLET_DID } from '@abtnode/constant';
import { authorize } from '../../components/launch-blocklet/util';

describe('launch-blocklet', () => {
  describe('util', () => {
    describe('authorize', () => {
      test('should return false if user is falsy', () => {
        expect(authorize({})).toBe(false);
        expect(authorize({ user: null })).toBe(false);
        expect(authorize({ user: '' })).toBe(false);
      });

      test('should throw error if launchType===serverless but nftId is falsy', () => {
        expect(() => authorize({ user: { controller: {} }, launchType: 'serverless' })).toThrowError(
          'nftId is required'
        );
        expect(() => authorize({ user: { controller: {} }, launchType: 'serverless', nftId: '' })).toThrowError(
          'nftId is required'
        );
        expect(() => authorize({ user: { controller: {} }, launchType: 'serverless', nftId: null })).toThrowError(
          'nftId is required'
        );
      });

      test('should return false if user.controller.nftId!==nftId', () => {
        expect(authorize({ user: {}, launchType: 'serverless', nftId: 'test-idxx' })).toBe(false);
        expect(authorize({ user: { controller: {} }, launchType: 'serverless', nftId: 'test-idxx' })).toBe(false);

        expect(
          authorize({ user: { controller: { nftId: 'test-id' } }, launchType: 'serverless', nftId: 'test-idxx' })
        ).toBe(false);
      });

      test('should return true if the user.permissions includes "mutate_blocklets"', () => {
        expect(authorize({ user: { permissions: ['mutate_blocklets'] } })).toBe(true);
      });

      test('should return false if the user.permissions does not include "mutate_blocklets"', () => {
        expect(authorize({ user: { permissions: ['query_blocklets'] } })).toBe(false);
        expect(authorize({ user: { permissions: [] } })).toBe(false);
        expect(authorize({ user: {} })).toBe(false);
      });

      test('should authorize an authenticated user for DeBOS only', () => {
        expect(authorize({ user: { approved: true, permissions: [] }, blockletDid: DEBOS_BLOCKLET_DID })).toBe(true);
        expect(authorize({ user: { approved: true, permissions: [] }, blockletDid: 'z8iOtherBlocklet' })).toBe(false);
        expect(authorize({ user: { approved: false, permissions: [] }, blockletDid: DEBOS_BLOCKLET_DID })).toBe(false);
        expect(authorize({ user: null, blockletDid: DEBOS_BLOCKLET_DID })).toBe(false);
      });
    });
  });
});
