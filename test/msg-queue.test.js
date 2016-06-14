'use strict';

const should = require('chai').should();
const request = require('request');
const spawn = require('child_process').spawn;
const randexp = require('randexp').randexp;

const Consumer = require('../index').Consumer;
const Producer = require('../index').Producer;

const removeTopicFromAllNsqd = (topic, cb) => {
  cb = cb || function() {};
  const nsqd = ['127.0.0.1:9041', '127.0.0.1:9042'];
  removeSingle(nsqd[0], () => {
    removeSingle(nsqd[1], cb);
  });

  function removeSingle(host, callback) {
    const option = {
      uri: `http://${host}/topic/delete?topic=${topic}`,
      method: 'POST'
    };
    request(option, (e, res, body) => {
      callback(e);
    });
  }
};

const runOnce = (callback) => {
  let count = 0;
  return (err) => {
    count++;
    if (err) {
      count = 2;
      return callback(err);
    }
    if (count === 2) {
      callback(err);
    }
  };
};

describe('msg queue', () => {

  describe('consumer', () => {
    const send = (topic, msg, cb) => {
      const option = {
        uri: `http://127.0.0.1:9042/put?topic=${topic}`,
        method: 'POST',
        body: msg
      };
      request(option, (e, res, body) => {
        cb(e);
      });
    };

    it('should receive message successfully', (done) => {
      const topic = randexp(/Consume-([a-z]{8})/);
      send(topic, 'hello nsq', () => {
        const c = new Consumer(topic, 'ipsum', {
            lookupdHTTPAddresses: ['127.0.0.1:9011', '127.0.0.1:9012']
          });
        c.consume((msg) => {
          msg.body.toString().should.be.equal('hello nsq');
          msg.finish();
          removeTopicFromAllNsqd(topic, done);
        });
      });
    });

    it('should be able to requeu message', function(done) {
      this.timeout(5000);
      const topic = randexp(/Consume-([a-z]{8})/);
      send(topic, 'test requeue', () => {
        const c = new Consumer(topic, 'sit', {
          lookupdHTTPAddresses: ['127.0.0.1:9011', '127.0.0.1:9012']
        });
        let n = 0;
        c.consume((msg) => {
          n++;
          msg.body.toString().should.be.equal('test requeue');
          if (n === 1) {
            msg.requeue(1500, false);
          }
          if (n === 2) {
            msg.finish();
            done();
          }
        });
      });
    });

  });

  describe('producer', function() {
    this.timeout(5000);

    it('should be able to publish to single nsqd', function(done) {
      const topic = randexp(/Single-([a-z]{8})/);
      const p = new Producer({
        nsqdHost: '127.0.0.1',
        tcpPort: 9031
      });
      p.connect(() => {
        p.produce(topic, 'test producer', (err) => {
          if (err) return done(err);
          const nsqTail = spawn('nsq_tail', ['--lookupd-http-address=127.0.0.1:9011',
              `--topic=${topic}`, '-n', '1']);
          nsqTail.stdout.on('data', (data) => {
            data.toString().should.contain('test producer');
          });
          nsqTail.on('close', (code) => {
            removeTopicFromAllNsqd(topic, done);
          });
        });
      });
    });

    it('should be able to publish to lookup', function(done) {
      const topic = randexp(/Lookup-([a-z]{8})/);
      const p = new Producer({
        lookupdHTTPAddresses: ['127.0.0.1:9011', '127.0.0.1:9012']
      });
      p.connect(() => {
        p.produce(topic, 'test lookup', (err) => {
          if (err) return done(err);
          const nsqTail = spawn('nsq_tail', ['--lookupd-http-address=127.0.0.1:9011',
              `--topic=${topic}`, '-n', '1']);
          nsqTail.stdout.on('data', (data) => {
            if (data.toString().trim()) {//need remove \n
              data.toString().should.contain('test lookup');
            }
          });
          nsqTail.on('close', (code) => {
            removeTopicFromAllNsqd(topic, done);
          });
        });
      });
    });

    it('should be called with error if lookup fails', function(done) {
      const p = new Producer({
        lookupdHTTPAddresses: ['127.0.0.1:9091', '127.0.0.1:9092'] //non-existed lookupd
      });
      p.connect((errors) => {
        errors.should.be.an('array');
        done();
      });
    });

    it('should be able to play round robin', function(done) {
      const topic = randexp(/Roundrobin-([a-z]{8})/);
      const p = new Producer({
        lookupdHTTPAddresses: ['127.0.0.1:9011', '127.0.0.1:9012']
      });
      const doneOnce = runOnce(() => {
        removeTopicFromAllNsqd(topic, done);
      });
      p.connect(() => {
        p.produce(topic, 'round1', (err) => {});
        p.produce(topic, 'round2', (err) => {});
        spawn('nsq_tail', ['--nsqd-tcp-address=127.0.0.1:9031',
            `--topic=${topic}`, '-n', '1'])
          .stdout.on('data', (data) => {
            if (data.toString().trim()) {//need remove \n
              data.toString().trim().should.contain('round');
            }
          })
          .on('close', (code) => {
            doneOnce(code);
          });
        spawn('nsq_tail', ['--nsqd-tcp-address=127.0.0.1:9032',
            `--topic=${topic}`, '-n', '1'])
          .stdout.on('data', (data) => {
            if (data.toString().trim()) {//need remove \n
              data.toString().trim().should.contain('round');
            }
          })
          .on('close', (code) => {
            doneOnce(code);
          });
      });
    });

    it('should be able to play fanout', function(done) {
      const topic = randexp(/Roundrobin-([a-z]{8})/);
      const p = new Producer({
        lookupdHTTPAddresses: ['127.0.0.1:9011', '127.0.0.1:9012']
      }, { strategy: Producer.FAN_OUT });
      const doneOnce = runOnce(() => {
        removeTopicFromAllNsqd(topic, done);
      });
      p.connect(() => {
        p.produce(topic, 'fanout message', (err) => {});
        spawn('nsq_tail', ['--nsqd-tcp-address=127.0.0.1:9031',
            `--topic=${topic}`, '-n', '1'])
          .stdout.on('data', (data) => {
            if (data.toString().trim()) {//need remove \n
              data.toString().should.contain('fanout message');
            }
          })
          .on('close', (code) => {
            doneOnce(code);
          });
        spawn('nsq_tail', ['--nsqd-tcp-address=127.0.0.1:9032',
            `--topic=${topic}`, '-n', '1'])
          .stdout.on('data', (data) => {
            if (data.toString().trim()) {//need remove \n
              data.toString().should.contain('fanout message');
            }
          })
          .on('close', (code) => {
            doneOnce(code);
          });
      });
    });

  });

});
