const Consumer = require('kafka/Consumer');

jest.mock('node-rdkafka');
jest.mock('logging/Logger');
jest.mock('kafka/CommitManager');
jest.mock('async');
jest.mock('uuid');
jest.mock('kafka/Helper');

const { v4: uuidMock } = require('uuid');

const CommitManagerMock = require('kafka/CommitManager');

const AsyncMock = require('async');

AsyncMock.queue = jest.fn((queueHandle) => {
  AsyncMock.queueHandle = queueHandle;
  AsyncMock.processingQueue = [];
  return {
    push: jest.fn((data, callback) => {
      AsyncMock.processingQueue = AsyncMock.processingQueue || [];
      AsyncMock.processingQueue.push({ data, callback });
    }),
    drain: jest.fn((drainCallback) => {
      AsyncMock.drainCallback = drainCallback;
    }),
    remove: jest.fn(() => {}),
    length: jest.fn(() => AsyncMock.processingQueue.length),
  };
});
AsyncMock.process = jest.fn(async () => {
  const element = AsyncMock.processingQueue.shift();
  await AsyncMock.queueHandle(element.data, element.callback);
  if (AsyncMock.processingQueue.length === 0) {
    await AsyncMock.drainCallback();
  }
});

const KafkaMock = require('node-rdkafka');
const Helper = require('../../../lib/kafka/Helper');

// Kafka Consumer Mock
KafkaMock.KafkaConsumer = class {
  constructor() {
    this.eventListener = {};
    this.emit = (event, data) => {
      this.eventListener[event](data);
    };
    this.on = jest.fn((event, cb) => {
      this.eventListener[event] = cb;
    });
    this.connect = jest.fn(() => {
      this.eventListener.ready();
    });
    this.commit = jest.fn();
    this.consume = jest.fn();
    this.subscribe = jest.fn();
    this.unsubscribe = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.assignments = jest.fn();
    this.unassign = jest.fn();
    this.disconnect = jest.fn((cb) => {
      this.eventListener.disconnected();
      cb();
    });
  }
};

expect.extend({
  toBeWithinRange(received, floor, ceiling) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    }

    return {
      message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
      pass: false,
    };
  },
});

test('Constructor: default', () => {
  const consumer = new Consumer();
  const expectedConfig = {
    'in.processing.max.messages': 1,
    'max.retries.processing.callbacks': 0,
    'queued.max.messages.bytes': 10485760,
    'subscription.backoff.min.ms': 1000,
    'subscription.backoff.max.ms': 60000,
    'subscription.backoff.delta.ms': 1000,
    'commit.interval.ms': 5000,
    'commit.on.failure': true,
    'kafka.consumer': {
      'enable.auto.commit': false,
    },
    'kafka.topic': {},
  };

  // check
  expect(consumer.config).toMatchObject(expectedConfig);
  expect(consumer.consumer).not.toBeNull();
  expect(consumer.commitManager).not.toBeNull();
  expect(consumer.msgQueue).not.toBeNull();
});

test('Constructor: divergent value for enable.auto.commit', () => {
  const consumer = new Consumer({
    'kafka.consumer': { 'enable.auto.commit': true },
  });
  const expectedConfig = {
    'in.processing.max.messages': 1,
    'max.retries.processing.callbacks': 0,
    'queued.max.messages.bytes': 10485760,
    'subscription.backoff.min.ms': 1000,
    'subscription.backoff.max.ms': 60000,
    'subscription.backoff.delta.ms': 1000,
    'commit.interval.ms': 5000,
    'commit.on.failure': true,
    'kafka.consumer': {
      'enable.auto.commit': false, // it must be disabled!
    },
    'kafka.topic': {},
  };

  // check
  expect(consumer.config).toMatchObject(expectedConfig);
  expect(consumer.consumer).not.toBeNull();
  expect(consumer.commitManager).not.toBeNull();
  expect(consumer.msgQueue).not.toBeNull();
});

test('Constructor: consumer and topic properties', () => {
  const consumer = new Consumer({
    'kafka.consumer': {
      'bootstrap.servers': ['kafka.server1', 'kafka.server2'],
    },
    'kafka.topic': {
      'auto.offset.reset': 'beginning',
    },
  });
  const expectedConfig = {
    'in.processing.max.messages': 1,
    'max.retries.processing.callbacks': 0,
    'queued.max.messages.bytes': 10485760,
    'subscription.backoff.min.ms': 1000,
    'subscription.backoff.max.ms': 60000,
    'subscription.backoff.delta.ms': 1000,
    'commit.interval.ms': 5000,
    'commit.on.failure': true,
    'kafka.consumer': {
      'bootstrap.servers': ['kafka.server1', 'kafka.server2'],
    },
    'kafka.topic': {
      'auto.offset.reset': 'beginning',
    },
  };

  // check
  expect(consumer.config).toMatchObject(expectedConfig);
  expect(consumer.consumer).not.toBeNull();
  expect(consumer.commitManager).not.toBeNull();
  expect(consumer.msgQueue).not.toBeNull();
});

test('Basic initialization', async () => {
  const consumer = new Consumer();
  consumer.refreshSubscriptions = jest.fn();
  const readyHandler = jest.fn();
  consumer.on('ready', readyHandler);
  await consumer.init();

  // check init behavior
  expect(consumer.isReady).toBe(true);
  expect(readyHandler).toHaveBeenCalled();
  expect(consumer.consumer.consume).toHaveBeenCalled();
  expect(consumer.refreshSubscriptions).toHaveBeenCalledTimes(1);
});

test('Get consumer status', async () => {
  const consumer = new Consumer();

  await consumer.getStatus();
  expect(Helper.getStatus).toBeCalledWith(consumer.consumer);
});

test('Failed initialization', async () => {
  expect.assertions(3);
  const consumer = new Consumer();
  consumer.consumer.connect = jest.fn((_unused, callback) => {
    callback(new Error('The kafka broker is not reachable.'));
  });
  const readyHandler = jest.fn();
  consumer.on('ready', readyHandler);

  try {
    await consumer.init();
  } catch (e) {
    expect(e).toEqual(new Error('The kafka broker is not reachable.'));
  }

  expect(consumer.isReady).toBe(false);
  expect(readyHandler).not.toHaveBeenCalled();
});

test('Finish - succeed even when the consumer is not ready', async () => {
  const consumer = new Consumer();
  consumer.consumer = new KafkaMock.KafkaConsumer();
  const disconnectedHandler = jest.fn();
  consumer.on('disconnected', disconnectedHandler);

  await consumer.finish();
  expect(consumer.consumer.unsubscribe).not.toHaveBeenCalled();
  expect(consumer.consumer.disconnect).not.toHaveBeenCalled();
  expect(disconnectedHandler).not.toHaveBeenCalled();
});

test('Finish - success', (done) => {
  const consumer = new Consumer();
  consumer.consumer = new KafkaMock.KafkaConsumer();
  const disconnectedHandler = jest.fn();
  consumer.on('disconnected', disconnectedHandler);

  consumer.init();
  consumer.isReady = true;

  consumer.commitManager = new CommitManagerMock();
  consumer.commitManager.finish = jest.fn(() => Promise.resolve());

  const callbackPromiseDisconnect = new Promise((resolve) => {
    const mockDisconnectedEvent = consumer.consumer.on.mock.calls[3][1];
    mockDisconnectedEvent();
    // set to ready again to test finish func
    consumer.isReady = true;
    resolve();
  });

  const consumerFinishPromise = consumer.finish();

  Promise.all([callbackPromiseDisconnect, consumerFinishPromise])
    .then(() => {
      expect(consumer.isReady).toBeFalsy();
      done();
    })
    .catch(done.fail);

  expect(disconnectedHandler).toHaveBeenCalled();
});

describe('Validates registerCallback', () => {
  it('using explicit topic', () => {
    const consumer = new Consumer({});
    consumer.refreshSubscriptions = jest.fn();

    const topicCallback = jest.fn();
    const targetTopic = 'amazingTopic';
    const expectedEntry = {
      id: 'random',
      callback: topicCallback,
    };
    uuidMock.mockReturnValueOnce(expectedEntry.id);

    consumer.registerCallback(targetTopic, topicCallback);

    // check registerCallback behavior
    expect(consumer.refreshSubscriptions).toHaveBeenCalledTimes(1);
    expect(Object.keys(consumer.topicMap)).toHaveLength(1);
    expect(consumer.topicMap).toHaveProperty(targetTopic);
    expect(consumer.topicMap[targetTopic]).toHaveLength(1);
    expect(consumer.topicMap[targetTopic]).toEqual(
      expect.arrayContaining([expectedEntry]),
    );
  });

  it('using RegExp topic', () => {
    const consumer = new Consumer({});
    consumer.refreshSubscriptions = jest.fn();

    const topicCallback = jest.fn();
    const targetTopic = /^tenant.*/;
    const expectedEntry = {
      id: 'random',
      callback: topicCallback,
      regExp: targetTopic,
    };
    uuidMock.mockReturnValueOnce(expectedEntry.id);

    consumer.registerCallback(targetTopic, topicCallback);

    // check registerCallback behavior
    expect(consumer.refreshSubscriptions).toHaveBeenCalledTimes(1);
    expect(Object.keys(consumer.topicRegExpArray)).toHaveLength(1);
    expect(consumer.topicRegExpArray).toEqual(
      expect.arrayContaining([expectedEntry]),
    );
  });

  it('registries on a repeated topic', () => {
    const consumer = new Consumer({});
    consumer.refreshSubscriptions = jest.fn();

    const targetTopic = 'amazingTopic';
    const mockedEntry = { id: 'entry', callback: jest.fn() };
    consumer.topicMap[targetTopic] = [mockedEntry];

    const topicCallback = jest.fn();
    const expectedEntry = {
      id: 'random',
      callback: topicCallback,
    };
    uuidMock.mockReturnValueOnce(expectedEntry.id);

    consumer.registerCallback(targetTopic, topicCallback);

    // check registerCallback behavior
    expect(consumer.refreshSubscriptions).not.toHaveBeenCalled();
    expect(Object.keys(consumer.topicMap)).toHaveLength(1);
    expect(consumer.topicMap).toHaveProperty(targetTopic);
    expect(consumer.topicMap[targetTopic]).toHaveLength(2);
    expect(consumer.topicMap[targetTopic]).toEqual(
      expect.arrayContaining([mockedEntry, expectedEntry]),
    );
  });
});

describe('Validates unregisterCallback', () => {
  let consumer = null;
  const entryRegExp1 = {
    id: 'entry1',
    callback: jest.fn(),
    regExp: /^tenant\/.*/,
  };
  const entryRegExp2 = {
    id: 'entry2',
    callback: jest.fn(),
    regExp: /^user\/.*/,
  };
  const entryExp1Elem1 = { id: 'entry3', callback: jest.fn() };
  const entryExp1Elem2 = { id: 'entry4', callback: jest.fn() };
  const entryExp2Elem1 = { id: 'entry5', callback: jest.fn() };
  const entryExp1 = 'user.juri';
  const entryExp2 = 'user.ryu';

  beforeEach(() => {
    consumer = new Consumer({});
    consumer.refreshSubscriptions = jest.fn();
    consumer.topicRegExpArray = [entryRegExp1, entryRegExp2];
    consumer.topicMap[entryExp1] = [entryExp1Elem1, entryExp1Elem2];
    consumer.topicMap[entryExp2] = [entryExp2Elem1];
  });
  test('explicit topic with one entry', async () => {
    consumer.unregisterCallback('entry5');

    expect(consumer.refreshSubscriptions).toHaveBeenCalledTimes(1);
    expect(Object.keys(consumer.topicMap)).toHaveLength(1);
    expect(consumer.topicMap).not.toHaveProperty(entryExp2);
    expect(consumer.topicMap[entryExp1]).toHaveLength(2);
    expect(consumer.topicRegExpArray).toHaveLength(2);
  });

  test('explicit topic with multiple entries', async () => {
    consumer.unregisterCallback('entry4');

    expect(consumer.refreshSubscriptions).not.toHaveBeenCalled();
    expect(Object.keys(consumer.topicMap)).toHaveLength(2);
    expect(consumer.topicMap[entryExp1]).toHaveLength(1);
    expect(consumer.topicRegExpArray).toHaveLength(2);
  });

  test('regExp topic', async () => {
    consumer.unregisterCallback('entry2');

    expect(consumer.refreshSubscriptions).toHaveBeenCalledTimes(1);
    expect(Object.keys(consumer.topicMap)).toHaveLength(2);
    expect(consumer.topicMap[entryExp1]).toHaveLength(2);
    expect(consumer.topicMap[entryExp2]).toHaveLength(1);
    expect(consumer.topicRegExpArray).toHaveLength(1);
    expect(consumer.topicRegExpArray).toEqual(
      expect.arrayContaining([entryRegExp1]),
    );
  });
});

describe('Message processing', () => {
  test('receives a new message', () => {
    const consumer = new Consumer({});
    consumer.commitManager = new CommitManagerMock();
    consumer.msgQueue = AsyncMock.queue(jest.fn());
    consumer.consumer = new KafkaMock.KafkaConsumer();

    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'tenant/dojot', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };
    consumer.onData(publishedData);

    expect(consumer.currQueueBytes).toBe(publishedData.size);
    expect(consumer.msgQueue.length()).toBe(1);
    expect(consumer.consumer.pause).toHaveBeenCalledTimes(0);
    expect(consumer.pause).toBeFalsy();
  });

  test('receives a new message (queue overflow)', () => {
    const consumer = new Consumer({});
    consumer.commitManager = new CommitManagerMock();
    consumer.msgQueue = AsyncMock.queue(jest.fn());
    consumer.consumer = new KafkaMock.KafkaConsumer();
    const pausedHandler = jest.fn();
    consumer.on('paused', pausedHandler);

    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 2e10, // size of the message, in bytes
      topic: 'tenant/dojot', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };
    consumer.onData(publishedData);

    expect(consumer.currQueueBytes).toBe(publishedData.size);
    expect(consumer.msgQueue.length()).toBe(1);
    expect(consumer.consumer.pause).toHaveBeenCalledTimes(1);
    expect(consumer.isPaused).toBeTruthy();
    expect(pausedHandler).toHaveBeenCalled();
  });
});

describe('handle kafka (Default Consumer)', () => {
  let consumer = null;
  beforeEach(() => {
    consumer = new Consumer({});
    consumer.commitManager = new CommitManagerMock();
    consumer.topicRegExpArray = [
      { id: 'entry1', callback: jest.fn(), regExp: /^tenant\/.*/ },
      { id: 'entry2', callback: jest.fn(), regExp: /^user\/.*/ },
      {
        id: 'entry3',
        callback: jest.fn(() => {
          throw new Error('Mocked error');
        }),
        regExp: /^troublemaker\/.*/,
      },
    ];
    consumer.topicMap['user/juri'] = [
      { id: 'entry4', callback: jest.fn() },
      { id: 'entry5', callback: jest.fn() },
    ];
    consumer.topicMap['troublemaker/denis'] = [
      { id: 'entry4', callback: jest.fn() },
      {
        id: 'entry5',
        callback: jest.fn(() => {
          throw new Error('Mocked error');
        }),
      },
    ];
  });
  test('Message processing with RegEx topic', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'tenant/dojot', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };
    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);

    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
  });

  test('Message processing with RegEx and explicit topic', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };
    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[1].callback).toHaveBeenCalledWith(
      publishedData,
    );
    expect(consumer.topicRegExpArray[1].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][1].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][1].callback,
    ).toHaveBeenCalledTimes(1);

    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
  });

  test('Message processing with failure', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'troublemaker/denis', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };
    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[2].callback).toHaveBeenCalledWith(
      publishedData,
    );
    expect(consumer.topicRegExpArray[2].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][1].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][1].callback,
    ).toHaveBeenCalledTimes(1);

    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('handle kafka (Processing Retry and Not Commit on Failure)', () => {
  let consumer = null;
  beforeEach(() => {
    consumer = new Consumer({
      'max.retries.processing.callbacks': 2,
      'commit.on.failure': false,
    });
    consumer.commitManager = new CommitManagerMock();
    consumer.topicRegExpArray = [
      {
        id: 'entry1',
        regExp: /^user\/.*/,
      },
    ];
    consumer.topicMap['user/juri'] = [{ id: 'entry2' }];
  });

  test('Message processing that succeeds in the first retry', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementationOnce();

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementationOnce();

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(2);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(2);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
  });

  test('Message processing that succeeds in the second retry', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementationOnce();

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementationOnce();

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(3);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(3);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
  });

  test('Message processing that fails in all retries', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    consumer.topicRegExpArray[0].callback = jest.fn().mockImplementation(() => {
      throw new Error();
    });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementation(() => {
        throw new Error();
      });

    const errorHandler = jest.fn();
    consumer.on('error.processing', errorHandler);

    consumer.finish = jest.fn();

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(3);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(3);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(consumer.finish).toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledWith(
      consumer.topicRegExpArray[0].id,
      publishedData,
    );
  });
});

describe('handle kafka (Async Commit)', () => {
  let consumer = null;
  beforeEach(() => {
    consumer = new Consumer({
      'max.retries.processing.callbacks': 2,
      'commit.on.failure': false,
      'enable.async.commit': true,
    });
    consumer.commitManager = new CommitManagerMock();
    consumer.topicRegExpArray = [
      {
        id: 'entry1',
        regExp: /^user\/.*/,
      },
    ];
    consumer.topicMap['user/juri'] = [{ id: 'entry2' }];
  });

  test('Received all acknowledgements (immediate ack)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ack1Return;
    let ack2Return;
    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack1Return = ack();
      });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack2Return = ack();
      });

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
    expect(ack1Return).toBeTruthy();
    expect(ack2Return).toBeTruthy();
  });

  test('Received all acknowledgements (out of order ack)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ack1;
    let ack2;
    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack1 = ack;
      });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack2 = ack;
      });

    await consumer.invokeInterestedCallbacks(publishedData);
    const ack2Return = ack2();
    const ack1Return = ack1();

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
    expect(ack1Return).toBeTruthy();
    expect(ack2Return).toBeTruthy();
  });

  test('Pending acknowledgements (all)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce(() => {});

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce(() => {});

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
  });

  test('Pending acknowledgements (one)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ackReturn;

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce(() => {});

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ackReturn = ack();
      });

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(ackReturn).toBeTruthy();
  });

  test('Pending acknowledgements (multiple acks - explicit topic)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ack1Return;
    let ack2Return;

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce(() => {});

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack1Return = ack();
        ack2Return = ack(); // second call
      });

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(ack1Return).toBeTruthy();
    expect(ack2Return).toBeFalsy();
  });

  test('Pending acknowledgements (multiple ack - regex topic)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ack1Return;
    let ack2Return;

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack1Return = ack();
        ack2Return = ack(); // second call
      });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce(() => {});

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(ack1Return).toBeTruthy();
    expect(ack2Return).toBeFalsy();
  });

  test('Message processing that fails for all retries', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    consumer.topicRegExpArray[0].callback = jest.fn().mockImplementation(() => {
      throw new Error();
    });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementation(() => {
        throw new Error();
      });

    const errorHandler = jest.fn();
    consumer.on('error.processing', errorHandler);

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(3);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(3);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(2);
    expect(errorHandler).toHaveBeenCalledWith(
      consumer.topicRegExpArray[0].id,
      publishedData,
    );
    expect(errorHandler).toHaveBeenCalledWith(
      consumer.topicMap[publishedData.topic][0].id,
      publishedData,
    );
  });

  test('Message processing that fails for all retries of a given callback (regex topic)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ackReturn;

    consumer.topicRegExpArray[0].callback = jest.fn().mockImplementation(() => {
      throw new Error();
    });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementation((data, ack) => {
        ackReturn = ack();
      });

    const errorHandler = jest.fn();
    consumer.on('error.processing', errorHandler);

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(3);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(
      consumer.topicRegExpArray[0].id,
      publishedData,
    );
    expect(ackReturn).toBeTruthy();
  });

  test('Message processing that fails for all retries of a given callback (explicit topic)', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ackReturn;

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementation((data, ack) => {
        ackReturn = ack();
      });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementation(() => {
        throw new Error();
      });

    const errorHandler = jest.fn();
    consumer.on('error.processing', errorHandler);

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(3);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(
      consumer.topicMap[publishedData.topic][0].id,
      publishedData,
    );
    expect(ackReturn).toBeTruthy();
  });

  test('Message processing that succeeds in the first retry', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ack1Return;
    let ack2Return;

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementation((data, ack) => {
        ack1Return = ack();
      });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error();
      })
      .mockImplementation((data, ack) => {
        ack2Return = ack();
      });

    consumer.invokeInterestedCallbacks(publishedData);

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(2);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(2);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).toHaveBeenCalledTimes(1);
    expect(ack1Return).toBeTruthy();
    expect(ack2Return).toBeTruthy();
  });

  test('Epoch Changed', async () => {
    const publishedData = {
      value: Buffer.from('konnichiwa'), // message contents as a Buffer
      size: 10, // size of the message, in bytes
      topic: 'user/juri', // topic the message comes from
      offset: 1337, // offset the message was read from
      partition: 1, // partition the message was on
      key: 'someKey', // key of the message if present
      timestamp: 1510325354780, // timestamp of message creation
    };

    let ack1;
    let ack2;

    consumer.topicRegExpArray[0].callback = jest
      .fn()
      .mockImplementationOnce((data, ack) => {
        ack1 = ack;
      });

    consumer.topicMap[publishedData.topic][0].callback = jest
      .fn()
      .mockImplementation((data, ack) => {
        ack2 = ack;
      });

    // invoke callbacks
    consumer.invokeInterestedCallbacks(publishedData);

    // change epoch (rebalance)
    consumer.epoch += 1;

    // late acknowledgements (previous epoch)
    const ack1Return = ack1();
    const ack2Return = ack2();

    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledWith(
      publishedData,
      expect.any(Function),
    );
    expect(consumer.topicRegExpArray[0].callback).toHaveBeenCalledTimes(1);
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledWith(publishedData, expect.any(Function));
    expect(
      consumer.topicMap[publishedData.topic][0].callback,
    ).toHaveBeenCalledTimes(1);
    expect(
      consumer.commitManager.notifyFinishedProcessing,
    ).not.toHaveBeenCalled();
    expect(ack1Return).toBeFalsy();
    expect(ack2Return).toBeFalsy();
  });
});

describe('Refresh subscription', () => {
  test('Refresh subscription', () => {
    // sets the fake timer to analyze the refreshSubscriptions
    jest.useFakeTimers();

    // test subject
    const consumer = new Consumer({});

    consumer.consumer = new KafkaMock.KafkaConsumer();
    consumer.isReady = true;
    const topic = 'tenant/dojot';
    consumer.topicMap[topic] = [{ id: 'entry1', callback: jest.fn() }];
    const regExpTopic = /^tenant\/.*/;
    consumer.topicRegExpArray = [
      { id: 'entry2', callback: jest.fn(), regExp: regExpTopic },
    ];
    consumer.refreshSubscriptions();

    // execute the setTimeout callbacks
    jest.runOnlyPendingTimers();

    expect(consumer.consumer.unsubscribe).toHaveBeenCalledTimes(1);
    expect(consumer.consumer.subscribe).toHaveBeenCalledTimes(1);
    expect(consumer.consumer.subscribe).toHaveBeenCalledWith([
      topic,
      regExpTopic,
    ]);
  });

  test('Refresh subscription with retry', (done) => {
    // sets the fake timer to analyze the refreshSubscriptions
    jest.useFakeTimers();

    const consumer = new Consumer({
      'subscription.backoff.min.ms': 1000,
      'subscription.backoff.max.ms': 10000,
      'subscription.backoff.delta.ms': 1000,
    });

    consumer.consumer = new KafkaMock.KafkaConsumer();
    consumer.isReady = true;
    const topic = 'tenant/dojot';
    consumer.topicMap[topic] = [{ id: 'entry', callback: jest.fn() }];

    consumer.consumer.subscribe = jest.fn();

    // Expected calls:
    // (1) subscriptionProcedure(/*retries*/ 0) -> fails
    // (2) t = 1000 + random(0, 1000): subscriptionProcedure(/*retries*/ 1) -> fails
    // (3) t = 2000 + random(0, 1000): subscriptionProcedure(/*retries*/ 2) -> fails
    // (4) t = 4000 + random(0, 1000): subscriptionProcedure(/*retries*/ 3) -> fails
    // (5) t = 8000 + random(0, 1000): subscriptionProcedure(/*retries*/ 4) -> fails
    // (6) t = 10000: subscriptionProcedure(/*retries*/ 4) -> fails
    // (7) t = 10000: succeeded
    consumer.consumer.subscribe
      .mockImplementationOnce(() => {
        throw Error('subscription mocked error');
      })
      .mockImplementationOnce(() => {
        throw Error('subscription mocked error');
      })
      .mockImplementationOnce(() => {
        throw Error('subscription mocked error');
      })
      .mockImplementationOnce(() => {
        throw Error('subscription mocked error');
      })
      .mockImplementationOnce(() => {
        throw Error('subscription mocked error');
      })
      .mockImplementationOnce(() => {
        throw Error('subscription mocked error');
      })
      .mockImplementationOnce(() => {
        done();
      });

    consumer.refreshSubscriptions();

    // check registerCallback behavior
    expect(consumer.isReady).toBe(true);
    expect(Object.keys(consumer.topicMap)).toHaveLength(1);

    jest.runAllTimers();

    expect(setTimeout).toHaveBeenCalledTimes(6);
    expect(setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.toBeWithinRange(1000, 2000),
      1,
    );
    expect(setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.toBeWithinRange(2000, 3000),
      2,
    );
    expect(setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.toBeWithinRange(4000, 5000),
      3,
    );
    expect(setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.toBeWithinRange(8000, 9000),
      4,
    );
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 10000, 5);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 10000, 6);

    expect(consumer.consumer.unsubscribe).toHaveBeenCalledTimes(7);
    expect(consumer.consumer.subscribe).toHaveBeenCalledTimes(7);
    expect(consumer.consumer.subscribe).toHaveBeenCalledWith([topic]);
  });
});

describe('Resume consumer', () => {
  it('when paused', () => {
    const consumer = new Consumer({});
    consumer.isPaused = true;
    consumer.consumer = new KafkaMock.KafkaConsumer();

    const resumedHandler = jest.fn();
    consumer.on('resumed', resumedHandler);

    consumer.resumeConsumer();

    expect(consumer.consumer.resume).toHaveBeenCalledTimes(1);
    expect(consumer.isPaused).toBeFalsy();
    expect(resumedHandler).toHaveBeenCalledTimes(1);
  });

  it('when is not paused', () => {
    const consumer = new Consumer({});
    consumer.consumer = new KafkaMock.KafkaConsumer();

    const resumedHandler = jest.fn();
    consumer.on('resumed', resumedHandler);

    consumer.resumeConsumer();

    expect(consumer.consumer.resume).toHaveBeenCalledTimes(0);
    expect(consumer.isPaused).toBeFalsy();
    expect(resumedHandler).not.toHaveBeenCalled();
  });
});

test('Rebalance - revoke partitions', () => {
  const consumer = new Consumer({});
  consumer.consumer = new KafkaMock.KafkaConsumer();
  consumer.commitManager = new CommitManagerMock();
  consumer.msgQueue = AsyncMock.queue(jest.fn());

  consumer.onRebalance(
    { code: KafkaMock.CODES.ERRORS.ERR__REVOKE_PARTITIONS },
    {},
  );

  expect(consumer.consumer.unassign).toHaveBeenCalledTimes(1);
  expect(consumer.commitManager.onRebalance).toHaveBeenCalledTimes(1);
  expect(consumer.msgQueue.remove).toHaveBeenCalledTimes(1);
  expect(consumer.consumer.resume).toHaveBeenCalledTimes(0);
  expect(consumer.isPaused).toBeFalsy();
});

test('Rebalance - revoke partitions: paused case', () => {
  const consumer = new Consumer({});
  consumer.consumer = new KafkaMock.KafkaConsumer();
  consumer.commitManager = new CommitManagerMock();
  consumer.msgQueue = AsyncMock.queue(jest.fn());
  consumer.isPaused = true;

  consumer.onRebalance(
    { code: KafkaMock.CODES.ERRORS.ERR__REVOKE_PARTITIONS },
    {},
  );

  expect(consumer.consumer.unassign).toHaveBeenCalledTimes(1);
  expect(consumer.commitManager.onRebalance).toHaveBeenCalledTimes(1);
  expect(consumer.msgQueue.remove).toHaveBeenCalledTimes(1);
  expect(consumer.consumer.resume).toHaveBeenCalledTimes(1);
  expect(consumer.isPaused).toBeFalsy();
});

test('Rebalance - assign partitions', () => {
  const consumer = new Consumer({});
  consumer.consumer.assign = jest.fn();
  consumer.onRebalance(
    { code: KafkaMock.CODES.ERRORS.ERR__ASSIGN_PARTITIONS },
    [1, 3, 5],
  );
  expect(consumer.consumer.assign).toHaveBeenCalledWith([1, 3, 5]);
});
